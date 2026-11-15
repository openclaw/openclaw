import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  prepareColdLoadTraceEvent,
  type ColdLoadTraceEvent,
} from "./control-ui-cold-load-trace.ts";

const categories = [
  "style",
  "layout",
  "prePaint",
  "paint",
  "layerize",
  "commit",
  "htmlParse",
  "cssParse",
  "scriptCompile",
  "gc",
] as const;
type Category = (typeof categories)[number];
type Span = { start: number; end: number };
type NativeInterval = Span & {
  category: Category;
  name: string;
  tid: number;
  cpu?: Span;
};
type Slice = Span & { category: Category };
type CategoryTotals = {
  events: number;
  wallMs: number;
  threadCpuMs: number | null;
  cpuClockEvents: number;
};

function categoryOf(name = ""): Category | undefined {
  switch (name) {
    case "UpdateLayoutTree":
    case "RecalculateStyles":
      return "style";
    case "Layout":
      return "layout";
    case "PrePaint":
      return "prePaint";
    case "Paint":
    case "PaintImage":
      return "paint";
    case "Layerize":
    case "UpdateLayerTree":
      return "layerize";
    case "Commit":
    case "CompositeLayers":
      return "commit";
    case "ParseHTML":
      return "htmlParse";
    case "ParseAuthorStyleSheet":
    case "CSSParserImpl::parseStyleSheet":
      return "cssParse";
  }
  if (
    /^(?:v8\.compile(?:Module)?|v8\.parseOnBackground|v8\.deserializeOnBackground|V8\.(?:Compile|Parse(?:Program|Function|Lazy)|DeserializeCode))/u.test(
      name,
    ) &&
    !/Wait/u.test(name)
  ) {
    return "scriptCompile";
  }
  if (/^(?:MinorGC|MajorGC|GCEvent|V8\.GC(?:_|\b)|BlinkGC\.)/u.test(name)) {
    return "gc";
  }
  return undefined;
}

function nativeIntervals(events: readonly ColdLoadTraceEvent[], pid: number): NativeInterval[] {
  const result: NativeInterval[] = [];
  const stacks = new Map<number, ColdLoadTraceEvent[]>();
  const add = (event: ColdLoadTraceEvent, end: number, cpuEnd?: number) => {
    const category = categoryOf(event.name);
    if (!category || end <= event.ts) {
      return;
    }
    result.push({
      category,
      name: event.name!,
      tid: event.tid,
      start: event.ts,
      end,
      cpu:
        event.tts !== undefined && cpuEnd !== undefined && cpuEnd >= event.tts
          ? { start: event.tts, end: cpuEnd }
          : undefined,
    });
  };
  // B/E events nest across all names, including names outside our category list.
  for (const event of events.filter((entry) => entry.pid === pid).toSorted((a, b) => a.ts - b.ts)) {
    if (event.ph === "X" && event.dur !== undefined) {
      add(
        event,
        event.ts + event.dur,
        event.tts !== undefined && event.tdur !== undefined ? event.tts + event.tdur : undefined,
      );
    } else if (event.ph === "B") {
      const stack = stacks.get(event.tid) ?? [];
      stack.push(event);
      stacks.set(event.tid, stack);
    } else if (event.ph === "E") {
      const begin = stacks.get(event.tid)?.pop();
      if (begin) {
        add(begin, event.ts, event.tts);
      }
    }
  }
  return result;
}

/** Attribute overlapping native spans to the innermost classified event. */
function exclusiveSlices(intervals: readonly NativeInterval[], clock: "wall" | "cpu") {
  const points = intervals.flatMap((interval) => {
    const span = clock === "wall" ? interval : interval.cpu;
    return span
      ? [
          { at: span.start, interval, begin: true },
          { at: span.end, interval, begin: false },
        ]
      : [];
  });
  points.sort((a, b) => a.at - b.at);
  const active = new Set<NativeInterval>();
  const incomplete = new Set<Category>();
  const slices: Slice[] = [];
  let previous = points[0]?.at ?? 0;
  for (let index = 0; index < points.length;) {
    const at = points[index]!.at;
    if (at > previous && active.size) {
      let owner: NativeInterval | undefined;
      let missingClock = false;
      for (const interval of active) {
        if (
          !owner ||
          interval.start > owner.start ||
          (interval.start === owner.start && interval.end <= owner.end)
        ) {
          owner = interval;
        }
        missingClock ||= !interval.cpu;
      }
      slices.push({ start: previous, end: at, category: owner!.category });
      if (clock === "wall" && missingClock) {
        // Without a nested event's clock its CPU cannot be subtracted from an
        // overlapping category. Keep those totals unknown, not wall-scaled.
        for (const interval of active) {
          incomplete.add(interval.category);
        }
      }
    }
    while (index < points.length && points[index]!.at === at) {
      const point = points[index++]!;
      if (point.begin) {
        active.add(point.interval);
      } else {
        active.delete(point.interval);
      }
    }
    previous = at;
  }
  return { slices, incomplete };
}

function summarizeThreads(intervals: readonly NativeInterval[]) {
  const totals = Object.fromEntries(
    categories.map((category) => [
      category,
      { events: 0, wallMs: 0, threadCpuMs: 0, cpuClockEvents: 0 },
    ]),
  ) as Record<Category, CategoryTotals>;
  const wallSlices: Slice[] = [];
  for (const tid of new Set(intervals.map((interval) => interval.tid))) {
    const selected = intervals.filter((interval) => interval.tid === tid);
    const wall = exclusiveSlices(selected, "wall");
    wallSlices.push(...wall.slices);
    for (const interval of selected) {
      totals[interval.category].events++;
      totals[interval.category].cpuClockEvents += Number(Boolean(interval.cpu));
    }
    for (const slice of wall.slices) {
      totals[slice.category].wallMs += (slice.end - slice.start) / 1_000;
    }
    for (const slice of exclusiveSlices(selected, "cpu").slices) {
      const total = totals[slice.category];
      if (total.threadCpuMs !== null) {
        total.threadCpuMs += (slice.end - slice.start) / 1_000;
      }
    }
    for (const category of wall.incomplete) {
      totals[category].threadCpuMs = null;
    }
  }
  return {
    summary: {
      categories: totals,
      wallMs: Object.values(totals).reduce((sum, total) => sum + total.wallMs, 0),
      threadCpuMs: Object.values(totals).every((total) => total.threadCpuMs !== null)
        ? Object.values(totals).reduce((sum, total) => sum + total.threadCpuMs!, 0)
        : null,
    },
    wallSlices,
  };
}

function correlateProgram(profileValue: unknown, slices: readonly Slice[]) {
  const limitation =
    "Elapsed sample weights intersect exclusive main-thread timeline slices on CDP's monotonic clock. This is sampled wall-time correlation, not measured CPU or causal attribution; unsampled and unmatched time remains unexplained. The leading (program) profiler-start interval is excluded, matching the CPU census.";
  if (profileValue === undefined || profileValue === null) {
    return { available: false as const, limitation };
  }
  const profile = asRecord(profileValue);
  const startTime = profile?.startTime;
  const endTime = profile?.endTime;
  const samples = profile?.samples;
  const deltas = profile?.timeDeltas;
  const nodes = profile?.nodes;
  if (
    typeof startTime !== "number" ||
    typeof endTime !== "number" ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime < startTime ||
    !Array.isArray(samples) ||
    !Array.isArray(deltas) ||
    samples.length !== deltas.length ||
    !Array.isArray(nodes)
  ) {
    throw new Error("Native trace correlation needs a complete CDP CPU profile");
  }
  const frames = new Map<number, string>();
  for (const value of nodes) {
    const node = asRecord(value);
    const name = asRecord(node?.callFrame)?.functionName;
    if (typeof node?.id !== "number" || typeof name !== "string") {
      throw new Error("Native trace correlation has an invalid profile node");
    }
    frames.set(node.id, name);
  }
  let timestamp = startTime;
  let leadInEnd = startTime;
  let outOfOrderSamples = 0;
  const timed = samples
    .map((id: unknown, index) => {
      const delta: unknown = deltas[index];
      if (
        typeof id !== "number" ||
        !frames.has(id) ||
        typeof delta !== "number" ||
        !Number.isFinite(delta)
      ) {
        throw new Error("Native trace correlation has an invalid profile sample");
      }
      timestamp += delta;
      outOfOrderSamples += Number(delta < 0);
      if (timestamp < startTime || timestamp > endTime) {
        throw new Error("Native trace correlation sample is outside the profile interval");
      }
      // Match createControlUiCpuCensus: Profiler.start's leading (program)
      // interval is initialization, not work performed by the measured action.
      if (index === 0 && frames.get(id) === "(program)") {
        leadInEnd = timestamp;
      }
      return { timestamp, id };
    })
    .toSorted((a, b) => a.timestamp - b.timestamp);
  const byCategory = Object.fromEntries(categories.map((category) => [category, 0])) as Record<
    Category,
    number
  >;
  const ordered = slices.toSorted((a, b) => a.start - b.start);
  let sampledWallMs = 0;
  let programSampledWallMs = 0;
  let rawSampledWallMs = 0;
  let rawProgramSampledWallMs = 0;
  let previous = startTime;
  let sliceIndex = 0;
  for (const sample of timed) {
    const start = Math.max(previous, leadInEnd);
    const elapsedMs = Math.max(0, sample.timestamp - start) / 1_000;
    rawSampledWallMs += (sample.timestamp - previous) / 1_000;
    sampledWallMs += elapsedMs;
    if (frames.get(sample.id) === "(program)") {
      rawProgramSampledWallMs += (sample.timestamp - previous) / 1_000;
      programSampledWallMs += elapsedMs;
      while (sliceIndex < ordered.length && ordered[sliceIndex]!.end <= start) {
        sliceIndex++;
      }
      for (let index = sliceIndex; index < ordered.length; index++) {
        const slice = ordered[index]!;
        if (slice.start >= sample.timestamp) {
          break;
        }
        byCategory[slice.category] +=
          Math.max(0, Math.min(slice.end, sample.timestamp) - Math.max(slice.start, start)) / 1_000;
      }
    }
    previous = sample.timestamp;
  }
  const explainedProgramSampledWallMs = Object.values(byCategory).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    available: true as const,
    startTimeUs: startTime,
    endTimeUs: endTime,
    profilerLeadInMs: (leadInEnd - startTime) / 1_000,
    rawSampledWallMs,
    rawProgramSampledWallMs,
    sampledWallMs,
    unsampledWallMs: (endTime - leadInEnd) / 1_000 - sampledWallMs,
    programSampledWallMs,
    explainedProgramSampledWallMs,
    unexplainedProgramSampledWallMs: Math.max(
      0,
      programSampledWallMs - explainedProgramSampledWallMs,
    ),
    byCategory,
    outOfOrderSamples,
    limitation,
  };
}

/** Native categories cover recognized spans, not all renderer or browser work. */
export function summarizeControlUiNativeTrace(rawEvents: readonly unknown[], profile: unknown) {
  const events = rawEvents.map(prepareColdLoadTraceEvent);
  const navigation = events.find(
    (event) => event.name === "navigationStart" && event.args?.data?.isLoadingMainFrame !== false,
  );
  const candidates = events.filter(
    (event) =>
      event.name === "thread_name" &&
      event.args?.name === "CrRendererMain" &&
      (!navigation || navigation.pid === event.pid),
  );
  const taskCounts = new Map<string, number>();
  for (const event of events) {
    if (
      (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask") &&
      event.ph !== "E"
    ) {
      const key = `${event.pid}:${event.tid}`;
      taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
    }
  }
  const renderer = candidates.toSorted(
    (a, b) =>
      (taskCounts.get(`${b.pid}:${b.tid}`) ?? 0) - (taskCounts.get(`${a.pid}:${a.tid}`) ?? 0),
  )[0];
  if (!renderer) {
    throw new Error("Native trace has no CrRendererMain thread");
  }
  const intervals = nativeIntervals(events, renderer.pid);
  const main = summarizeThreads(intervals.filter((interval) => interval.tid === renderer.tid));
  const other = summarizeThreads(intervals.filter((interval) => interval.tid !== renderer.tid));
  const names = new Map<string, { category?: Category; count: number }>();
  for (const event of events) {
    if (
      event.pid !== renderer.pid ||
      event.tid !== renderer.tid ||
      !event.name ||
      (event.ph !== "X" && event.ph !== "B")
    ) {
      continue;
    }
    const row = names.get(event.name) ?? { category: categoryOf(event.name), count: 0 };
    row.count++;
    names.set(event.name, row);
  }
  return {
    rendererPid: renderer.pid,
    rendererTid: renderer.tid,
    mainThread: main.summary,
    otherRendererThreads: other.summary,
    eventNames: [...names]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, row]) => ({ name, category: row.category, count: row.count })),
    program: correlateProgram(profile, main.wallSlices),
    accounting:
      "Categories are exclusive within each thread: the innermost recognized span owns overlaps. Other renderer threads are summed independently, not unioned with the main thread. Missing or overlapping incomplete thread clocks produce null CPU totals. Unrecognized events, unmatched B/E spans, compositor/GPU work and untraced native work are not attributed.",
  };
}
