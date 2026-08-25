import { yaml } from '@codemirror/lang-yaml'
import { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { toBlob } from 'html-to-image'
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const MAX_SOURCE_LENGTH = 200_000
const MAX_EVENTS = 800
const MAX_TEXT_LENGTH = 300
const MAX_DAYS = 120

const MINUTES_PER_DAY = 1440
const MAX_DURATION_MINUTES = MAX_DAYS * MINUTES_PER_DAY

const HOUR_HEIGHT = 46
const GUTTER_WIDTH = 58
const DAY_WIDTH = 148

const PALETTE = {
  violet: { bg: 'bg-violet-200', border: 'border-violet-400', text: 'text-violet-900' },
  indigo: { bg: 'bg-indigo-200', border: 'border-indigo-400', text: 'text-indigo-900' },
  cyan: { bg: 'bg-cyan-200', border: 'border-cyan-400', text: 'text-cyan-900' },
  teal: { bg: 'bg-teal-200', border: 'border-teal-400', text: 'text-teal-900' },
  green: { bg: 'bg-green-200', border: 'border-green-400', text: 'text-green-900' },
  lime: { bg: 'bg-lime-200', border: 'border-lime-400', text: 'text-lime-900' },
  yellow: { bg: 'bg-yellow-200', border: 'border-yellow-400', text: 'text-yellow-900' },
  orange: { bg: 'bg-orange-200', border: 'border-orange-400', text: 'text-orange-900' },
  red: { bg: 'bg-red-200', border: 'border-red-400', text: 'text-red-900' },
  pink: { bg: 'bg-pink-200', border: 'border-pink-400', text: 'text-pink-900' },
  slate: { bg: 'bg-slate-200', border: 'border-slate-400', text: 'text-slate-900' },
} as const

type ColorName = keyof typeof PALETTE

const COLOR_NAMES = Object.keys(PALETTE) as [ColorName, ...ColorName[]]
const DEFAULT_COLOR: ColorName = 'indigo'
const colorSchema = z.enum(COLOR_NAMES)

type PlanEvent = z.infer<typeof eventSchema> & { id: string }

type Plan = {
  title: string
  days: string[]
  events: PlanEvent[]
}

type Issue = {
  message: string
  line?: number
}

type Moment = { date: string; minutes: number }

const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ tT](\d{1,2}):([0-5]\d)$/

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dateFromIso(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function addDays(iso: string, amount: number): string {
  const date = dateFromIso(iso)
  date.setUTCDate(date.getUTCDate() + amount)
  return toIsoDate(date)
}

function daysBetween(from: string, to: string): number {
  const diff = dateFromIso(to).getTime() - dateFromIso(from).getTime()
  return Math.round(diff / 86_400_000)
}

const textSchema = z
  .union([z.string(), z.number().finite()], { error: 'is required' })
  .transform((value) => String(value).trim().slice(0, MAX_TEXT_LENGTH))
  .refine((value) => value.length > 0, 'is required')

const isoDateSchema = z.iso.date()

const momentSchema = z.union([
  z.date().transform(
    (value): Moment => ({
      date: toIsoDate(value),
      minutes: value.getUTCHours() * 60 + value.getUTCMinutes(),
    }),
  ),
  z.string().trim().transform((value, ctx): Moment => {
    const match = DATETIME_PATTERN.exec(value)
    if (!match) {
      ctx.addIssue({ code: 'custom', message: 'invalid datetime' })
      return z.NEVER
    }
    const date = isoDateSchema.safeParse(match[1])
    const hours = Number(match[2])
    if (!date.success || hours > 23) {
      ctx.addIssue({ code: 'custom', message: 'invalid datetime' })
      return z.NEVER
    }
    return { date: date.data, minutes: hours * 60 + Number(match[3]) }
  }),
], { error: 'must use the YYYY-MM-DD HH:MM format' })

const DURATION_ERROR = 'must be a number of minutes, such as 90'

const durationSchema = z
  .number({ error: DURATION_ERROR })
  .finite()
  .transform((value) => Math.round(value))
  .refine((value) => value > 0 && value <= MAX_DURATION_MINUTES, DURATION_ERROR)

const documentSchema = z.object({
  title: z.unknown().optional(),
  events: z.array(z.unknown()),
})

function softText(value: unknown): string | undefined {
  const parsed = textSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function formatMinutes(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hours = Math.floor(normalized / 60)
  const mins = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

function formatRange(event: PlanEvent): string {
  return `${formatMinutes(event.startMinutes)} - ${formatMinutes(event.endMinutes)}`
}

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function resolveEnd(date: string, startMinutes: number, duration?: number): Moment {
  if (duration === undefined) {
    return { date, minutes: Math.min(startMinutes + 60, MINUTES_PER_DAY) }
  }

  const absolute = startMinutes + duration
  return {
    date: addDays(date, Math.floor(absolute / MINUTES_PER_DAY)),
    minutes: absolute % MINUTES_PER_DAY,
  }
}

const eventSchema = z
  .object({
    title: textSchema,
    datetime: momentSchema,
    duration: durationSchema.optional(),
    color: colorSchema.catch(DEFAULT_COLOR).default(DEFAULT_COLOR),
  })
  .transform((raw, ctx) => {
    const { date, minutes: startMinutes } = raw.datetime
    const end = resolveEnd(date, startMinutes, raw.duration)

    if (daysBetween(date, end.date) * MINUTES_PER_DAY + end.minutes <= startMinutes) {
      ctx.addIssue({ code: 'custom', message: 'the end must come after "datetime"' })
      return z.NEVER
    }

    return {
      title: raw.title,
      date,
      endDate: end.date,
      startMinutes,
      endMinutes: end.minutes,
      color: raw.color,
    }
  })

function eventTimeBounds(event: PlanEvent, origin: string): { start: number; end: number } {
  return {
    start: daysBetween(origin, event.date) * MINUTES_PER_DAY + event.startMinutes,
    end: daysBetween(origin, event.endDate) * MINUTES_PER_DAY + event.endMinutes,
  }
}

function eventsOverlap(a: PlanEvent, b: PlanEvent): boolean {
  const origin = [a.date, b.date, a.endDate, b.endDate].sort()[0]!
  const boundsA = eventTimeBounds(a, origin)
  const boundsB = eventTimeBounds(b, origin)
  return boundsA.start < boundsB.end && boundsB.start < boundsA.end
}

function findEventOverlapIssues(events: PlanEvent[]): Issue[] {
  const issues: Issue[] = []

  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const first = events[i]!
      const second = events[j]!
      if (!eventsOverlap(first, second)) continue

      issues.push({
        message: `event #${i + 1} ("${first.title}") overlaps event #${j + 1} ("${second.title}").`,
      })
    }
  }

  return issues
}

function buildDayRange(events: PlanEvent[], issues: Issue[]): string[] {
  let first: string | null = null
  let last: string | null = null

  for (const event of events) {
    if (!first || event.date < first) first = event.date
    if (!last || event.endDate > last) last = event.endDate
  }

  if (!first || !last) return []

  const total = daysBetween(first, last) + 1
  if (total > MAX_DAYS) {
    issues.push({
      message: `A range of ${total} days exceeds the limit of ${MAX_DAYS}; showing the first ${MAX_DAYS}.`,
    })
  }

  const days: string[] = []
  for (let i = 0; i < Math.min(total, MAX_DAYS); i += 1) {
    days.push(addDays(first, i))
  }
  return days
}

function parsePlan(source: string): { plan: Plan | null; issues: Issue[] } {
  const issues: Issue[] = []

  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      plan: null,
      issues: [
        {
          message: `The document has ${source.length} characters and exceeds the limit of ${MAX_SOURCE_LENGTH}.`,
        },
      ],
    }
  }

  if (!source.trim()) {
    return { plan: null, issues: [] }
  }

  let document: unknown
  try {
    document = parseYaml(source, {
      merge: false,
      maxAliasCount: 100,
    })
  } catch (error) {
    const yamlError = error as { message?: string; linePos?: [{ line: number }] }
    return {
      plan: null,
      issues: [
        {
          message: yamlError.message ?? 'Invalid YAML.',
          line: yamlError.linePos?.[0]?.line,
        },
      ],
    }
  }

  const parsedDoc = documentSchema.safeParse(document)
  if (!parsedDoc.success) {
    const eventsIssue = parsedDoc.error.issues.some((issue) => issue.path[0] === 'events')
    return {
      plan: null,
      issues: [
        {
          message: eventsIssue
            ? 'The "events" key is required and must be a list.'
            : 'The document must be a YAML map with an "events" key.',
        },
      ],
    }
  }

  const rawEvents = parsedDoc.data.events
  if (rawEvents.length > MAX_EVENTS) {
    issues.push({
      message: `The list has ${rawEvents.length} events and exceeds the limit of ${MAX_EVENTS}; the extra ones were ignored.`,
    })
  }

  const events: PlanEvent[] = []
  rawEvents.slice(0, MAX_EVENTS).forEach((entry, index) => {
    const parsed = eventSchema.safeParse(entry)
    if (parsed.success) {
      events.push({ id: `event-${index}`, ...parsed.data })
      return
    }
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.')
      issues.push({
        message: `event #${index + 1}${field ? ` ("${field}")` : ''}: ${issue.message}.`,
      })
    }
  })

  issues.push(...findEventOverlapIssues(events))

  return {
    plan: {
      title: softText(parsedDoc.data.title) ?? 'Untitled',
      days: buildDayRange(events, issues),
      events,
    },
    issues,
  }
}

type EventSegment = {
  key: string
  event: PlanEvent
  start: number
  end: number
  continuesBefore: boolean
  continuesAfter: boolean
  column: number
  columnCount: number
}

type DayColumn = {
  date: string
  segments: EventSegment[]
}

type CalendarLayout = {
  days: DayColumn[]
  startHour: number
  endHour: number
}

type PendingSegment = Omit<EventSegment, 'column' | 'columnCount'>

function splitIntoSegments(event: PlanEvent, dayIndex: Map<string, number>) {
  const firstDay = dayIndex.get(event.date)
  const spanDays = daysBetween(event.date, event.endDate)
  const segments: Array<{ date: string; segment: PendingSegment }> = []

  if (firstDay === undefined) return segments

  const absoluteStart = firstDay * MINUTES_PER_DAY + event.startMinutes
  const absoluteEnd = (firstDay + spanDays) * MINUTES_PER_DAY + event.endMinutes

  for (const [date, index] of dayIndex) {
    const dayStart = index * MINUTES_PER_DAY
    const dayEnd = dayStart + MINUTES_PER_DAY
    if (absoluteEnd <= dayStart || absoluteStart >= dayEnd) continue

    const start = Math.max(absoluteStart, dayStart) - dayStart
    const end = Math.min(absoluteEnd, dayEnd) - dayStart

    segments.push({
      date,
      segment: {
        key: `${event.id}-${date}`,
        event,
        start,
        end,
        continuesBefore: absoluteStart < dayStart,
        continuesAfter: absoluteEnd > dayEnd,
      },
    })
  }

  return segments
}

function packColumns(segments: PendingSegment[]): EventSegment[] {
  const sorted = [...segments].sort(
    (a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key),
  )

  const packed: EventSegment[] = []
  let cluster: EventSegment[] = []
  let clusterEnd = -1
  const columnEnds: number[] = []

  const flush = () => {
    const columnCount = columnEnds.length
    for (const item of cluster) item.columnCount = columnCount
    packed.push(...cluster)
    cluster = []
    columnEnds.length = 0
    clusterEnd = -1
  }

  for (const segment of sorted) {
    if (cluster.length > 0 && segment.start >= clusterEnd) flush()

    let column = columnEnds.findIndex((end) => end <= segment.start)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(segment.end)
    } else {
      columnEnds[column] = segment.end
    }

    cluster.push({ ...segment, column, columnCount: 1 })
    clusterEnd = Math.max(clusterEnd, segment.end)
  }

  if (cluster.length > 0) flush()

  return packed
}

function visibleHours(days: DayColumn[]): { startHour: number; endHour: number } {
  const segments = days.flatMap((day) => day.segments)
  if (segments.length === 0) return { startHour: 8, endHour: 20 }

  return {
    startHour: Math.floor(Math.min(...segments.map((s) => s.start)) / 60),
    endHour: Math.min(24, Math.ceil(Math.max(...segments.map((s) => s.end)) / 60)),
  }
}

function buildLayout(events: PlanEvent[], days: string[]): CalendarLayout {
  const dayIndex = new Map(days.map((date, index) => [date, index]))
  const byDay = new Map<string, PendingSegment[]>(days.map((date) => [date, []]))

  for (const event of events) {
    for (const { date, segment } of splitIntoSegments(event, dayIndex)) {
      byDay.get(date)?.push(segment)
    }
  }

  const layoutDays: DayColumn[] = days.map((date) => ({
    date,
    segments: packColumns(byDay.get(date) ?? []),
  }))

  return { days: layoutDays, ...visibleHours(layoutDays) }
}

const BLOCK_GAP = 2
const BLOCK_INSET_X = 1
const BLOCK_TRIM_X = 3
const BLOCK_MIN_HEIGHT = 14
const BLOCK_RADIUS = 6

function segmentBox(segment: EventSegment, startHour: number) {
  const span = ((segment.end - segment.start) / 60) * HOUR_HEIGHT
  const height = Math.max(span - BLOCK_GAP, BLOCK_MIN_HEIGHT)

  return {
    top: ((segment.start - startHour * 60) / 60) * HOUR_HEIGHT,
    height,
    leftRatio: segment.column / segment.columnCount,
    widthRatio: 1 / segment.columnCount,
    topRadius: segment.continuesBefore ? 0 : BLOCK_RADIUS,
    bottomRadius: segment.continuesAfter ? 0 : BLOCK_RADIUS,
    showTime: !segment.continuesBefore,
  }
}

function planFileName(plan: Plan): string {
  const slug = plan.title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'plan'}.png`
}

async function downloadPlanImage(node: HTMLElement, fileName: string): Promise<void> {
  const blob = await toBlob(node, {
    backgroundColor: '#ffffff',
    pixelRatio: 2,
    cacheBust: true,
  })
  if (!blob) throw new Error('The image could not be generated.')

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const editorExtensions = [
  yaml(),
  EditorView.lineWrapping,
  EditorView.theme({
    '&': { height: '100%', fontSize: '13px' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: '1.6',
    },
    '.cm-gutters': { backgroundColor: '#f8fafc', border: 'none' },
    '&.cm-focused': { outline: 'none' },
  }),
]

function YamlEditor({
  value,
  onChange,
  issues,
}: {
  value: string
  onChange: (next: string) => void
  issues: Issue[]
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <CodeMirror
          className="absolute inset-0 overflow-hidden"
          value={value}
          onChange={onChange}
          extensions={editorExtensions}
          height="100%"
          basicSetup={{ foldGutter: true, highlightActiveLine: true }}
        />
      </div>

      {issues.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-amber-200 bg-amber-50 px-4 py-2">
          <p className="text-xs font-semibold text-amber-900">
            {issues.length === 1 ? '1 issue' : `${issues.length} issues`}
          </p>
          <ul className="mt-1 space-y-1">
            {issues.map((issue, index) => (
              <li key={index} className="text-xs text-amber-800">
                {issue.line !== undefined && (
                  <span className="mr-1 font-mono font-semibold">line {issue.line}:</span>
                )}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function EventBlock({
  segment,
  startHour,
}: {
  segment: EventSegment
  startHour: number
}) {
  const { event } = segment
  const colors = PALETTE[event.color]
  const box = segmentBox(segment, startHour)

  return (
    <div
      className={`absolute overflow-hidden border px-1 py-0.5 text-[10px] leading-[1.15] ${colors.bg} ${colors.border} ${colors.text}`}
      style={{
        top: box.top,
        height: box.height,
        left: `calc(${box.leftRatio * 100}% + ${BLOCK_INSET_X}px)`,
        width: `calc(${box.widthRatio * 100}% - ${BLOCK_TRIM_X}px)`,
        borderRadius: `${box.topRadius}px ${box.topRadius}px ${box.bottomRadius}px ${box.bottomRadius}px`,
      }}
      title={`${event.title}\n${formatRange(event)}`}
    >
      <div className="font-medium">{event.title}</div>
      {box.showTime && <div className="opacity-70">{formatRange(event)}</div>}
    </div>
  )
}

function PlanCalendar({
  plan,
  ref,
}: {
  plan: Plan
  ref?: Ref<HTMLDivElement>
}) {
  const layout = useMemo(() => buildLayout(plan.events, plan.days), [plan])

  if (plan.days.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-slate-500">
        No events with a valid date yet. Add an item under
        <code className="mx-1 rounded bg-slate-100 px-1">events</code>
        to see the calendar.
      </div>
    )
  }

  const hours = Array.from(
    { length: Math.max(layout.endHour - layout.startHour, 1) },
    (_, index) => layout.startHour + index,
  )
  const gridHeight = hours.length * HOUR_HEIGHT
  const minWidth = GUTTER_WIDTH + plan.days.length * DAY_WIDTH

  return (
    <div className="h-full overflow-auto bg-white">
      <div ref={ref} className="bg-white" style={{ minWidth }}>
        <header className="border-b border-slate-200 px-6 py-4 text-center">
          <h2 className="text-lg font-semibold text-slate-900">{plan.title}</h2>
        </header>

        <div
          className="grid"
          style={{
            gridTemplateColumns: `${GUTTER_WIDTH}px repeat(${plan.days.length}, minmax(${DAY_WIDTH}px, 1fr))`,
            minWidth,
          }}
        >
          <div className="sticky top-0 left-0 z-30 border-r border-b border-slate-200 bg-white" />
          {plan.days.map((date) => (
            <div
              key={`head-${date}`}
              className="sticky top-0 z-20 border-r border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-xs font-semibold text-slate-600"
            >
              {DAY_FORMATTER.format(dateFromIso(date))}
            </div>
          ))}

          <div
            className="sticky left-0 z-10 border-r border-slate-200 bg-white"
            style={{ height: gridHeight }}
          >
            {hours.map((hour, index) => (
              <div
                key={`hour-${hour}`}
                className="absolute right-2 -translate-y-1/2 text-[10px] font-medium text-slate-400"
                style={{ top: index * HOUR_HEIGHT }}
              >
                {index === 0 ? '' : formatMinutes(hour * 60)}
              </div>
            ))}
          </div>

          {layout.days.map((day) => (
            <div
              key={`col-${day.date}`}
              className="relative border-r border-slate-200"
              style={{ height: gridHeight }}
            >
              {hours.map((hour, index) => (
                <div
                  key={`line-${day.date}-${hour}`}
                  className="absolute inset-x-0 border-t border-slate-100"
                  style={{ top: index * HOUR_HEIGHT }}
                />
              ))}
              {day.segments.map((segment) => (
                <EventBlock
                  key={segment.key}
                  segment={segment}
                  startHour={layout.startHour}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const STORAGE_KEY = 'planfile:source:v3'

function loadInitialSource(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && stored.length <= MAX_SOURCE_LENGTH) return stored
  } catch {}
  return SAMPLE_PLAN
}

function App() {
  const [source, setSource] = useState(loadInitialSource)
  const deferredSource = useDeferredValue(source)
  const calendarRef = useRef<HTMLDivElement>(null)

  const { plan, issues } = useMemo(() => parsePlan(deferredSource), [deferredSource])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (source === SAMPLE_PLAN) localStorage.removeItem(STORAGE_KEY)
        else localStorage.setItem(STORAGE_KEY, source)
      } catch {}
    }, 400)
    return () => clearTimeout(timer)
  }, [source])

  const [exportError, setExportError] = useState<string | null>(null)

  const eventCount = plan?.events.length ?? 0
  const canExport = plan !== null && plan.days.length > 0
  const hasDraft = source !== SAMPLE_PLAN

  const handleClearDraft = () => {
    if (!window.confirm('Discard the current draft and restore the sample plan?')) return
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
    setSource(SAMPLE_PLAN)
    setExportError(null)
  }

  const handleExport = async () => {
    if (!plan || !calendarRef.current) return
    setExportError(null)
    try {
      await downloadPlanImage(calendarRef.current, planFileName(plan))
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to generate the image.')
    }
  }

  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Planfile</h1>
          <span className="text-xs text-slate-500">
            {eventCount === 1 ? '1 event' : `${eventCount} events`}
            {plan &&
              plan.days.length > 0 &&
              ` · ${plan.days.length} ${plan.days.length === 1 ? 'day' : 'days'}`}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {exportError && (
            <span className="text-xs text-red-600" role="alert">
              {exportError}
            </span>
          )}
          <button
            type="button"
            onClick={handleClearDraft}
            disabled={!hasDraft}
            title="Remove the saved draft and restore the sample plan"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            Clear draft
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!canExport}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Download image
          </button>
        </div>
      </header>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel
          id="editor"
          defaultSize="42"
          minSize="22"
          maxSize="78"
          className="min-w-0 overflow-hidden"
        >
          <div className="h-full border-r border-slate-200 bg-white">
            <YamlEditor value={source} onChange={setSource} issues={issues} />
          </div>
        </Panel>

        <Separator
          aria-label="Resize panels"
          className="w-1.5 bg-slate-200 transition-colors hover:bg-indigo-400 focus-visible:bg-indigo-400"
        />

        <Panel id="calendar" minSize="22" className="min-w-0 overflow-hidden">
          {plan ? (
            <PlanCalendar plan={plan} ref={calendarRef} />
          ) : (
            <div className="flex h-full items-center justify-center bg-white p-8 text-center text-sm text-slate-500">
              {issues.length > 0
                ? 'Fix the issues listed in the editor to see the calendar.'
                : 'Write a plan in YAML to get started.'}
            </div>
          )}
        </Panel>
      </Group>
    </div>
  )
}

export default App

const SAMPLE_PLAN = `title: Atacama/Cusco/Lima Itinerary

events:
  - { title: "Check-in and boarding (Fortaleza)", datetime: "2026-08-08 02:45", duration: 120, color: slate }
  - { title: "Flight LA3455 Fortaleza to Sao Paulo (GRU)", datetime: "2026-08-08 04:45", duration: 215, color: indigo }
  - { title: "Connection in Guarulhos (plane change)", datetime: "2026-08-08 08:20", duration: 85, color: slate }
  - { title: "Flight LA627 Sao Paulo to Santiago (SCL)", datetime: "2026-08-08 09:45", duration: 200, color: indigo }
  - { title: "Connection in Santiago (plane change)", datetime: "2026-08-08 13:05", duration: 149, color: slate }
  - { title: "Flight LA148 Santiago to Calama (CJC)", datetime: "2026-08-08 15:34", duration: 131, color: indigo }
  - { title: "Van transfer to San Pedro", datetime: "2026-08-08 18:15", duration: 90, color: pink }
  - { title: "Dinner (Adobe)", datetime: "2026-08-08 20:00", duration: 90, color: yellow }
  - { title: "Sleep (Ckoi Atacama Lodge)", datetime: "2026-08-08 23:00", duration: 480, color: violet }

  - { title: "Breakfast (Ckoi Atacama Lodge)", datetime: "2026-08-09 07:15", duration: 45, color: yellow }
  - { title: "Lunch (La Estaka)", datetime: "2026-08-09 12:30", duration: 60, color: yellow }
  - { title: "Van to Valle de la Luna", datetime: "2026-08-09 14:45", duration: 30, color: pink }
  - { title: "Duna Mayor", datetime: "2026-08-09 15:15", duration: 40, color: green }
  - { title: "Amphitheater and Tres Marias", datetime: "2026-08-09 16:05", duration: 45, color: green }
  - { title: "Mina Victoria", datetime: "2026-08-09 17:00", duration: 30, color: green }
  - { title: "Mirador de Ckari (sunset)", datetime: "2026-08-09 17:40", duration: 60, color: green }
  - { title: "Van back to San Pedro", datetime: "2026-08-09 18:40", duration: 30, color: pink }
  - { title: "Quick dinner (Inti)", datetime: "2026-08-09 19:45", duration: 45, color: yellow }
  - { title: "Van to stargazing site", datetime: "2026-08-09 20:45", duration: 30, color: pink }
  - { title: "Stargazing", datetime: "2026-08-09 21:15", duration: 90, color: green }
  - { title: "Van back to San Pedro", datetime: "2026-08-09 22:45", duration: 30, color: pink }
  - { title: "Sleep (Ckoi Atacama Lodge)", datetime: "2026-08-09 23:30", duration: 480, color: violet }

  - { title: "Breakfast (Ckoi Atacama Lodge)", datetime: "2026-08-10 08:00", duration: 45, color: yellow }
  - { title: "Lunch (Las Delicias de Carmen)", datetime: "2026-08-10 13:00", duration: 60, color: yellow }
  - { title: "Tour van to Laguna Cejar", datetime: "2026-08-10 15:00", duration: 30, color: pink }
  - { title: "Laguna Cejar (swim)", datetime: "2026-08-10 15:30", duration: 75, color: green }
  - { title: "Ojos del Salar", datetime: "2026-08-10 16:45", duration: 45, color: green }
  - { title: "Laguna Tebenquinche (sunset)", datetime: "2026-08-10 17:30", duration: 60, color: green }
  - { title: "Van back to San Pedro", datetime: "2026-08-10 18:30", duration: 30, color: pink }
  - { title: "Dinner (Pulperia Atacama)", datetime: "2026-08-10 19:15", duration: 90, color: yellow }
  - { title: "Sleep (Ckoi Atacama Lodge)", datetime: "2026-08-10 21:00", duration: 450, color: violet }

  - { title: "Tour van to Geysers del Tatio", datetime: "2026-08-11 05:00", duration: 90, color: pink }
  - { title: "Geysers del Tatio (geothermal field)", datetime: "2026-08-11 06:30", duration: 120, color: green }
  - { title: "Breakfast on the altiplano", datetime: "2026-08-11 08:30", duration: 60, color: yellow }
  - { title: "Van descending from the altiplano", datetime: "2026-08-11 09:30", duration: 60, color: pink }
  - { title: "Pueblo de Machuca", datetime: "2026-08-11 10:30", duration: 45, color: green }
  - { title: "Van back to San Pedro (Putana ford)", datetime: "2026-08-11 11:15", duration: 45, color: pink }
  - { title: "Lunch (La Pica del Indio)", datetime: "2026-08-11 12:30", duration: 60, color: yellow }
  - { title: "Van to Termas de Puritama", datetime: "2026-08-11 14:30", duration: 45, color: pink }
  - { title: "Termas de Puritama", datetime: "2026-08-11 15:15", duration: 120, color: green }
  - { title: "Van back to San Pedro", datetime: "2026-08-11 17:15", duration: 45, color: pink }
  - { title: "Taxi to Ephedra (Ayllu de Poconche)", datetime: "2026-08-11 18:45", duration: 20, color: pink }
  - { title: "Dinner (Ephedra, book ahead)", datetime: "2026-08-11 19:15", duration: 150, color: yellow }
  - { title: "Taxi back to San Pedro", datetime: "2026-08-11 21:45", duration: 20, color: pink }
  - { title: "Sleep (Ckoi Atacama Lodge)", datetime: "2026-08-11 22:30", duration: 480, color: violet }

  - { title: "Tour van to Laguna Chaxa", datetime: "2026-08-12 07:00", duration: 90, color: pink }
  - { title: "Laguna Chaxa (flamingos)", datetime: "2026-08-12 08:30", duration: 75, color: green }
  - { title: "Van to Piedras Rojas", datetime: "2026-08-12 09:45", duration: 105, color: pink }
  - { title: "Piedras Rojas", datetime: "2026-08-12 11:30", duration: 90, color: green }
  - { title: "Van to Socaire", datetime: "2026-08-12 13:00", duration: 45, color: pink }
  - { title: "Lunch in Socaire (included in tour)", datetime: "2026-08-12 13:45", duration: 60, color: yellow }
  - { title: "Van to Lagunas Altiplanicas", datetime: "2026-08-12 14:45", duration: 45, color: pink }
  - { title: "Lagunas Altiplanicas (Miscanti and Miniques)", datetime: "2026-08-12 15:30", duration: 60, color: green }
  - { title: "Van back to San Pedro", datetime: "2026-08-12 16:30", duration: 90, color: pink }
  - { title: "Dinner (Baltinache, reserve)", datetime: "2026-08-12 19:00", duration: 90, color: yellow }
  - { title: "Sleep (Ckoi Atacama Lodge)", datetime: "2026-08-12 21:00", duration: 480, color: violet }

  - { title: "Van transfer to Calama", datetime: "2026-08-13 05:43", duration: 90, color: pink }
  - { title: "Check-in and boarding (Calama)", datetime: "2026-08-13 07:13", duration: 120, color: slate }
  - { title: "Flight LA151 Calama to Santiago (SCL)", datetime: "2026-08-13 09:13", duration: 128, color: indigo }
  - { title: "Connection in Santiago (plane change)", datetime: "2026-08-13 11:21", duration: 129, color: slate }
  - { title: "Flight LA520 Santiago to Lima (LIM)", datetime: "2026-08-13 13:30", duration: 175, color: indigo }
  - { title: "Connection in Lima (plane change)", datetime: "2026-08-13 16:25", duration: 110, color: slate }
  - { title: "Flight LA2223 Lima to Cusco (CUZ)", datetime: "2026-08-13 18:15", duration: 85, color: indigo }
  - { title: "Taxi from airport to hotel (Cusco)", datetime: "2026-08-13 20:00", duration: 30, color: pink }
  - { title: "Dinner (Organika)", datetime: "2026-08-13 20:45", duration: 60, color: yellow }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-13 22:00", duration: 480, color: violet }

  - { title: "Breakfast (Golden Inca)", datetime: "2026-08-14 06:45", duration: 45, color: yellow }
  - { title: "Laundry (Atacama clothes, express wash)", datetime: "2026-08-14 08:00", duration: 90, color: orange }
  - { title: "San Pedro Market", datetime: "2026-08-14 09:40", duration: 60, color: green }
  - { title: "Cusco Cathedral", datetime: "2026-08-14 10:50", duration: 45, color: teal }
  - { title: "Qorikancha (Temple of the Sun)", datetime: "2026-08-14 11:45", duration: 45, color: teal }
  - { title: "Lunch (LIMO Peruvian nikkei)", datetime: "2026-08-14 12:40", duration: 55, color: yellow }
  - { title: "Taxi to Tambomachay (8 km)", datetime: "2026-08-14 13:40", duration: 25, color: pink }
  - { title: "Tambomachay", datetime: "2026-08-14 14:10", duration: 30, color: green }
  - { title: "Taxi to Puka Pukara (1 km)", datetime: "2026-08-14 14:40", duration: 10, color: pink }
  - { title: "Puka Pukara", datetime: "2026-08-14 14:55", duration: 25, color: green }
  - { title: "Taxi to Qenqo (3.5 km)", datetime: "2026-08-14 15:20", duration: 15, color: pink }
  - { title: "Qenqo", datetime: "2026-08-14 15:40", duration: 30, color: green }
  - { title: "Taxi to Sacsayhuaman (2 km)", datetime: "2026-08-14 16:10", duration: 10, color: pink }
  - { title: "Sacsayhuaman", datetime: "2026-08-14 16:25", duration: 60, color: green }
  - { title: "Walk down to Plaza de Armas", datetime: "2026-08-14 17:30", duration: 40, color: green }
  - { title: "Dinner (Chicha, reserve)", datetime: "2026-08-14 19:00", duration: 90, color: yellow }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-14 22:00", duration: 480, color: violet }

  - { title: "Breakfast (Golden Inca)", datetime: "2026-08-15 06:10", duration: 40, color: yellow }
  - { title: "Van to Pisac", datetime: "2026-08-15 07:00", duration: 45, color: pink }
  - { title: "Pisac archaeological site", datetime: "2026-08-15 07:45", duration: 105, color: green }
  - { title: "Pisac Market", datetime: "2026-08-15 09:30", duration: 60, color: green }
  - { title: "Van back to Cusco", datetime: "2026-08-15 10:30", duration: 45, color: pink }
  - { title: "Qorikancha Site Museum", datetime: "2026-08-15 11:30", duration: 40, color: teal }
  - { title: "Lunch (Cicciolina)", datetime: "2026-08-15 12:30", duration: 60, color: yellow }
  - { title: "Popular Art Museum", datetime: "2026-08-15 13:40", duration: 30, color: teal }
  - { title: "Regional History Museum (Casa de Garcilaso)", datetime: "2026-08-15 14:30", duration: 45, color: teal }
  - { title: "Contemporary Art Museum", datetime: "2026-08-15 15:30", duration: 30, color: teal }
  - { title: "Pachacutec Monument (viewpoint)", datetime: "2026-08-15 16:15", duration: 30, color: teal }
  - { title: "Dinner (Pachapapa, San Blas)", datetime: "2026-08-15 17:30", duration: 60, color: yellow }
  - { title: "Centro Qosqo de Arte Nativo (dances)", datetime: "2026-08-15 19:00", duration: 75, color: green }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-15 21:30", duration: 480, color: violet }

  - { title: "Breakfast (Golden Inca)", datetime: "2026-08-16 06:00", duration: 25, color: yellow }
  - { title: "Tour pickup and van to Chinchero", datetime: "2026-08-16 06:30", duration: 60, color: pink }
  - { title: "Chinchero (site and textile center)", datetime: "2026-08-16 07:30", duration: 90, color: green }
  - { title: "Van to Moray", datetime: "2026-08-16 09:00", duration: 40, color: pink }
  - { title: "Moray (circular terraces)", datetime: "2026-08-16 09:40", duration: 60, color: green }
  - { title: "Van to the salt pans", datetime: "2026-08-16 10:40", duration: 25, color: pink }
  - { title: "Maras Salt Mines", datetime: "2026-08-16 11:05", duration: 60, color: green }
  - { title: "Van to Urubamba", datetime: "2026-08-16 12:05", duration: 25, color: pink }
  - { title: "Tour buffet lunch (Urubamba)", datetime: "2026-08-16 12:30", duration: 60, color: yellow }
  - { title: "Van to Ollantaytambo", datetime: "2026-08-16 13:30", duration: 30, color: pink }
  - { title: "Ollantaytambo Fortress", datetime: "2026-08-16 14:00", duration: 90, color: green }
  - { title: "Free time in Ollantaytambo (town and cafes)", datetime: "2026-08-16 15:30", duration: 120, color: orange }
  - { title: "Early dinner (Chuncho, Ollantaytambo)", datetime: "2026-08-16 17:30", duration: 75, color: yellow }
  - { title: "Expedition 75 train to Aguas Calientes", datetime: "2026-08-16 19:04", duration: 101, color: pink }
  - { title: "Sleep (Horizonte, Aguas Calientes)", datetime: "2026-08-16 21:00", duration: 390, color: violet }

  - { title: "Machu Picchu ticket line", datetime: "2026-08-17 03:30", duration: 240, color: slate }
  - { title: "Breakfast (La Boulangerie)", datetime: "2026-08-17 07:45", duration: 45, color: yellow }
  - { title: "Walk to Jardines de Mandor", datetime: "2026-08-17 08:30", duration: 60, color: green }
  - { title: "Jardines de Mandor (waterfall)", datetime: "2026-08-17 09:30", duration: 90, color: green }
  - { title: "Walk back (to the museum)", datetime: "2026-08-17 11:00", duration: 45, color: green }
  - { title: "Manuel Chavez Ballon Site Museum", datetime: "2026-08-17 11:45", duration: 45, color: teal }
  - { title: "Walk back to Aguas Calientes", datetime: "2026-08-17 12:30", duration: 30, color: green }
  - { title: "Lunch (Aguas Calientes Market)", datetime: "2026-08-17 13:45", duration: 75, color: yellow }
  - { title: "Buy bus ticket (Consettur)", datetime: "2026-08-17 15:15", duration: 30, color: orange }
  - { title: "Hot Springs", datetime: "2026-08-17 16:00", duration: 90, color: green }
  - { title: "Craft market", datetime: "2026-08-17 17:45", duration: 45, color: orange }
  - { title: "Dinner (Indio Feliz, reserve)", datetime: "2026-08-17 19:00", duration: 90, color: yellow }
  - { title: "Sleep (Horizonte, Aguas Calientes)", datetime: "2026-08-17 20:30", duration: 450, color: violet }

  - { title: "Bus line to Machu Picchu", datetime: "2026-08-18 04:30", duration: 60, color: slate }
  - { title: "Bus up to Machu Picchu", datetime: "2026-08-18 05:30", duration: 25, color: pink }
  - { title: "Machu Picchu (Circuit 2, guided visit)", datetime: "2026-08-18 06:00", duration: 150, color: green }
  - { title: "Bus down to Aguas Calientes", datetime: "2026-08-18 08:45", duration: 25, color: pink }
  - { title: "Free time and market (Aguas Calientes)", datetime: "2026-08-18 09:30", duration: 120, color: orange }
  - { title: "Lunch (Tree House)", datetime: "2026-08-18 12:30", duration: 75, color: yellow }
  - { title: "Vistadome 74P train to Ollantaytambo", datetime: "2026-08-18 14:55", duration: 135, color: pink }
  - { title: "Transfer and bimodal bus to Wanchaq (Cusco)", datetime: "2026-08-18 17:10", duration: 110, color: pink }
  - { title: "Taxi from Wanchaq to hotel", datetime: "2026-08-18 19:00", duration: 20, color: pink }
  - { title: "Light dinner (Organika)", datetime: "2026-08-18 19:45", duration: 75, color: yellow }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-18 21:00", duration: 420, color: violet }

  - { title: "Van from Cusco to Mollepata", datetime: "2026-08-19 04:30", duration: 150, color: pink }
  - { title: "Breakfast in Mollepata", datetime: "2026-08-19 07:00", duration: 45, color: yellow }
  - { title: "Van from Mollepata to Soraypampa", datetime: "2026-08-19 07:45", duration: 45, color: pink }
  - { title: "Hike up to Laguna Humantay", datetime: "2026-08-19 08:30", duration: 120, color: green }
  - { title: "Laguna Humantay (~4,200m)", datetime: "2026-08-19 10:30", duration: 60, color: green }
  - { title: "Hike down", datetime: "2026-08-19 11:30", duration: 60, color: green }
  - { title: "Van from Soraypampa to Mollepata", datetime: "2026-08-19 12:30", duration: 45, color: pink }
  - { title: "Lunch in Mollepata", datetime: "2026-08-19 13:15", duration: 75, color: yellow }
  - { title: "Van from Mollepata to Cusco", datetime: "2026-08-19 14:30", duration: 240, color: pink }
  - { title: "Dinner (Morena)", datetime: "2026-08-19 19:30", duration: 90, color: yellow }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-19 22:00", duration: 480, color: violet }

  - { title: "Breakfast (Golden Inca)", datetime: "2026-08-20 07:00", duration: 45, color: yellow }
  - { title: "Van to Tipon", datetime: "2026-08-20 08:15", duration: 45, color: pink }
  - { title: "Tipon (site and Inca canals)", datetime: "2026-08-20 09:00", duration: 60, color: green }
  - { title: "Van to Pikillacta", datetime: "2026-08-20 10:00", duration: 30, color: pink }
  - { title: "Pikillacta (Wari city)", datetime: "2026-08-20 10:30", duration: 60, color: green }
  - { title: "Lunch (La Casona del Cuy, Tipon)", datetime: "2026-08-20 12:30", duration: 60, color: yellow }
  - { title: "Andahuaylillas (Sistine Chapel of the Americas)", datetime: "2026-08-20 13:30", duration: 60, color: teal }
  - { title: "Van back to Cusco", datetime: "2026-08-20 14:30", duration: 60, color: pink }
  - { title: "Early dinner (Uchu Peruvian Steakhouse)", datetime: "2026-08-20 18:00", duration: 60, color: yellow }
  - { title: "Sleep (Golden Inca, Cusco)", datetime: "2026-08-20 19:30", duration: 450, color: violet }

  - { title: "Van from Cusco to Cusipata", datetime: "2026-08-21 03:30", duration: 120, color: pink }
  - { title: "Breakfast in Cusipata", datetime: "2026-08-21 05:30", duration: 45, color: yellow }
  - { title: "Van from Cusipata to trailhead", datetime: "2026-08-21 06:15", duration: 45, color: pink }
  - { title: "Hike up to Vinicunca", datetime: "2026-08-21 07:00", duration: 90, color: green }
  - { title: "Vinicunca viewpoint (~5,036m)", datetime: "2026-08-21 08:30", duration: 60, color: green }
  - { title: "Hike down", datetime: "2026-08-21 09:30", duration: 75, color: green }
  - { title: "Van from trailhead to Cusipata", datetime: "2026-08-21 10:45", duration: 60, color: pink }
  - { title: "Lunch in Cusipata", datetime: "2026-08-21 11:45", duration: 75, color: yellow }
  - { title: "Van from Cusipata to Cusco", datetime: "2026-08-21 13:00", duration: 210, color: pink }
  - { title: "Rest and shower in room (checkout on the 22nd)", datetime: "2026-08-21 17:00", duration: 90, color: orange }
  - { title: "Dinner (Baco, before the flight)", datetime: "2026-08-21 19:00", duration: 90, color: yellow }
  - { title: "Taxi to airport (Cusco)", datetime: "2026-08-21 21:00", duration: 30, color: pink }
  - { title: "Check-in and boarding (Cusco)", datetime: "2026-08-21 22:05", duration: 120, color: slate }

  - { title: "Flight LA2222 Cusco to Lima (LIM)", datetime: "2026-08-22 00:05", duration: 90, color: indigo }
  - { title: "Taxi to Miraflores (Lima)", datetime: "2026-08-22 02:00", duration: 45, color: pink }
  - { title: "Sleep (Lexus, Lima)", datetime: "2026-08-22 03:00", duration: 390, color: violet }
  - { title: "Breakfast (Lexus, confirm hours)", datetime: "2026-08-22 09:30", duration: 25, color: yellow }
  - { title: "Lima Historic Center (Plaza Mayor)", datetime: "2026-08-22 10:00", duration: 120, color: green }
  - { title: "Larco Museum", datetime: "2026-08-22 12:20", duration: 70, color: teal }
  - { title: "Lunch (Cafe del Museo Larco)", datetime: "2026-08-22 13:30", duration: 75, color: yellow }
  - { title: "Taxi to Huaca Pucllana", datetime: "2026-08-22 14:45", duration: 30, color: pink }
  - { title: "Huaca Pucllana", datetime: "2026-08-22 15:15", duration: 75, color: green }
  - { title: "Miraflores (Malecon and Parque del Amor)", datetime: "2026-08-22 16:45", duration: 60, color: green }
  - { title: "Barranco (Puente de los Suspiros)", datetime: "2026-08-22 18:00", duration: 75, color: green }
  - { title: "Dinner (Isolina, reserve)", datetime: "2026-08-22 19:30", duration: 105, color: yellow }
  - { title: "Sleep (Lexus, Lima)", datetime: "2026-08-22 22:00", duration: 480, color: violet }

  - { title: "Taxi to airport (Lima)", datetime: "2026-08-23 06:40", duration: 45, color: pink }
  - { title: "Check-in and boarding (Lima)", datetime: "2026-08-23 07:25", duration: 120, color: slate }
  - { title: "Flight LA2414 Lima to Rio de Janeiro (GIG)", datetime: "2026-08-23 09:25", duration: 425, color: indigo }
`
