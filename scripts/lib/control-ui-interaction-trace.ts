import {
  prepareColdLoadTraceEvent,
  type ColdLoadCpuProfile,
  type ColdLoadTraceEvent,
} from "./control-ui-cold-load-trace.ts";

type Interval = { start: number; end: number };

const scriptEvents = new Set([
  "EvaluateScript",
  "FunctionCall",
  "RunMicrotasks",
  "V8.Execute",
  "v8.execute",
]);
const styleEvents = new Set(["UpdateLayoutTree", "RecalculateStyles"]);
const taskEvents = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);

function union(intervals: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of intervals.toSorted((left, right) => left.start - right.start)) {
    const previous = result.at(-1);
    // Adjacent tasks remain separate; nested/overlapping slices count only once.
    if (previous && interval.start < previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

const durationMs = (intervals: readonly Interval[]) =>
  union(intervals).reduce((total, interval) => total + interval.end - interval.start, 0) / 1_000;

/** Warm actions are bounded by unique performance marks, never navigation timing. */
export function summarizeInteractionTrace(
  rawEvents: readonly unknown[],
  marks: { start: string; end: string },
) {
  if (!marks.start || !marks.end || marks.start === marks.end) {
    throw new Error("Interaction trace needs distinct start/end mark names");
  }
  const events = rawEvents.map(prepareColdLoadTraceEvent);
  const boundary = (name: string) => {
    const matches = events.filter((event) => event.name === name);
    if (matches.length !== 1) {
      throw new Error(`Interaction trace needs exactly one mark: ${name}`);
    }
    return matches[0]!;
  };
  const start = boundary(marks.start);
  const end = boundary(marks.end);
  if (!Number.isFinite(start.ts) || !Number.isFinite(end.ts) || end.ts <= start.ts) {
    throw new Error("Interaction trace end must follow its start");
  }
  if (start.pid !== end.pid || start.tid !== end.tid) {
    throw new Error("Interaction trace marks must share a renderer main thread");
  }
  if (
    !events.some(
      (event) =>
        event.pid === start.pid &&
        event.tid === start.tid &&
        event.name === "thread_name" &&
        event.args?.name === "CrRendererMain",
    )
  ) {
    throw new Error("Interaction trace marks are not on CrRendererMain");
  }

  const tasks: Interval[] = [];
  const scripts: Interval[] = [];
  const layouts: Interval[] = [];
  const styles: Interval[] = [];
  const forcedLayouts: Interval[] = [];
  const stack: ColdLoadTraceEvent[] = [];
  const add = (event: ColdLoadTraceEvent, finish: number) => {
    const interval = { start: Math.max(start.ts, event.ts), end: Math.min(end.ts, finish) };
    if (interval.end <= interval.start) {
      return;
    }
    if (taskEvents.has(event.name ?? "")) {
      tasks.push(interval);
    } else if (scriptEvents.has(event.name ?? "")) {
      scripts.push(interval);
    } else if (styleEvents.has(event.name ?? "")) {
      styles.push(interval);
    } else if (event.name === "Layout") {
      layouts.push(interval);
      if (event.args?.beginData?.stackTrace?.length) {
        forcedLayouts.push(interval);
      }
    }
  };
  const threadEvents = events
    .filter((event) => event.pid === start.pid && event.tid === start.tid)
    .toSorted((left, right) => left.ts - right.ts);
  for (const event of threadEvents) {
    if (event.ph === "X" && event.dur !== undefined) {
      add(event, event.ts + event.dur);
    } else if (event.ph === "B") {
      stack.push(event);
    } else if (event.ph === "E") {
      const begin = stack.pop();
      if (begin) {
        add(begin, event.ts);
      }
    }
  }
  const taskIntervals = union(tasks);
  // Threshold and durations describe only work inside the requested interval.
  const longTasks = taskIntervals.filter((task) => task.end - task.start >= 50_000);
  return {
    startUs: start.ts,
    endUs: end.ts,
    durationMs: (end.ts - start.ts) / 1_000,
    rendererPid: start.pid,
    rendererTid: start.tid,
    taskCount: taskIntervals.length,
    busyMs: durationMs(taskIntervals),
    longTasks: longTasks.length,
    longTaskMs: durationMs(longTasks),
    longestTaskMs: Math.max(0, ...taskIntervals.map((task) => (task.end - task.start) / 1_000)),
    scriptCount: scripts.length,
    scriptMs: durationMs(scripts),
    layoutCount: layouts.length,
    layoutMs: durationMs(layouts),
    styleCount: styles.length,
    styleMs: durationMs(styles),
    forcedLayouts: forcedLayouts.length,
    forcedLayoutMs: durationMs(forcedLayouts),
  };
}

/** CDP CPU profile timestamps and trace marks share the monotonic microsecond clock. */
export function clipInteractionCpuProfile(
  profile: ColdLoadCpuProfile & { startTime: number; endTime: number },
  startUs: number,
  endUs: number,
) {
  if (
    ![profile.startTime, profile.endTime, startUs, endUs].every(Number.isFinite) ||
    profile.endTime <= profile.startTime ||
    endUs <= startUs
  ) {
    throw new Error("Interaction CPU profile needs valid profile and mark intervals");
  }
  const sourceSamples = profile.samples ?? [];
  const sourceDeltas = profile.timeDeltas ?? [];
  if (!sourceSamples.length || sourceSamples.length !== sourceDeltas.length) {
    throw new Error("Interaction CPU profile needs matching samples and time deltas");
  }
  let timestamp = profile.startTime;
  const timedSamples = sourceSamples
    .map((id, index) => {
      const delta = sourceDeltas[index]!;
      timestamp += delta;
      if (!Number.isFinite(delta) || timestamp < profile.startTime) {
        throw new Error("Interaction CPU profile has an invalid sample time");
      }
      return { id, timestamp };
    })
    .toSorted((left, right) => left.timestamp - right.timestamp);
  const startTime = Math.max(profile.startTime, startUs);
  const endTime = Math.min(profile.endTime, endUs);
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  let previousTimestamp = profile.startTime;
  for (const sample of timedSamples) {
    // Match summarizeCpuProfile: each sample owns the interval preceding its timestamp.
    const delta = Math.min(endTime, sample.timestamp) - Math.max(startTime, previousTimestamp);
    previousTimestamp = sample.timestamp;
    if (delta > 0) {
      samples.push(sample.id);
      timeDeltas.push(delta);
    }
  }
  if (!samples.length) {
    throw new Error("Interaction CPU profile has no samples in the marked interval");
  }
  return { ...profile, startTime, endTime, samples, timeDeltas };
}
