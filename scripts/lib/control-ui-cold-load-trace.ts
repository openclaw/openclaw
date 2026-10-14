import { readFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";

export type ColdLoadTraceEvent = {
  name?: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: {
    name?: string;
    snapshot?: string;
    data?: { isLoadingMainFrame?: boolean };
    beginData?: { stackTrace?: readonly unknown[] };
  };
};

/** CDP leaves trace dictionaries untyped; raw captures retain their other fields. */
export function prepareColdLoadTraceEvent(value: unknown): ColdLoadTraceEvent {
  const event = asRecord(value);
  if (
    !event ||
    (event.name !== undefined && typeof event.name !== "string") ||
    typeof event.ph !== "string" ||
    typeof event.ts !== "number" ||
    typeof event.pid !== "number" ||
    typeof event.tid !== "number" ||
    (event.dur !== undefined && typeof event.dur !== "number")
  ) {
    throw new Error("Invalid Chrome trace event envelope");
  }
  const args = asRecord(event.args);
  const data = asRecord(args?.data);
  const begin = asRecord(args?.beginData);
  const stackTrace = begin?.stackTrace;
  return {
    name: event.name,
    ph: event.ph,
    ts: event.ts,
    pid: event.pid,
    tid: event.tid,
    dur: event.dur,
    args: args
      ? {
          name: typeof args.name === "string" ? args.name : undefined,
          snapshot: typeof args.snapshot === "string" ? args.snapshot : undefined,
          data: data
            ? {
                isLoadingMainFrame:
                  typeof data.isLoadingMainFrame === "boolean"
                    ? data.isLoadingMainFrame
                    : undefined,
              }
            : undefined,
          beginData: Array.isArray(stackTrace) ? { stackTrace } : undefined,
        }
      : undefined,
  };
}

export type ColdLoadCpuFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type ColdLoadCpuProfile = {
  nodes: readonly {
    id: number;
    callFrame: ColdLoadCpuFrame;
    children?: readonly number[];
  }[];
  samples?: readonly number[];
  timeDeltas?: readonly number[];
};

export async function mapColdLoadCpuProfile(
  profile: ColdLoadCpuProfile,
  options: { assetBaseUrl: string; assetDirectory: string },
) {
  const base = new URL(options.assetBaseUrl);
  const directory = path.resolve(options.assetDirectory);
  const maps = new Map<string, Promise<SourceMap | null>>();
  let mappedFrames = 0;
  let unmappedFrames = 0;
  const nodes = await Promise.all(
    profile.nodes.map(async (node) => {
      const frame = node.callFrame;
      const url = URL.parse(frame.url);
      if (
        !url ||
        url.origin !== base.origin ||
        frame.lineNumber < 0 ||
        !/\.m?js$/u.test(url.pathname)
      ) {
        return node;
      }
      // Preview also serves relative entry assets beneath the deep-link path.
      const assetStart = url.pathname.lastIndexOf(base.pathname);
      if (assetStart < 0) {
        return node;
      }
      const relative = decodeURIComponent(url.pathname.slice(assetStart + base.pathname.length));
      const file = path.resolve(directory, relative);
      if (!file.startsWith(`${directory}${path.sep}`)) {
        throw new Error("CPU profile asset is outside the build directory");
      }
      let pending = maps.get(file);
      if (!pending) {
        pending = readFile(`${file}.map`, "utf8").then(
          (content) => new SourceMap(JSON.parse(content)),
          (error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          },
        );
        maps.set(file, pending);
      }
      const map = await pending;
      if (!map) {
        unmappedFrames++;
        return node;
      }
      const origin = map.findOrigin(frame.lineNumber + 1, frame.columnNumber + 1);
      if (!("fileName" in origin)) {
        unmappedFrames += 1;
        return node;
      }
      mappedFrames += 1;
      return {
        ...node,
        callFrame: {
          functionName: origin.name ?? frame.functionName,
          url: origin.fileName,
          lineNumber: origin.lineNumber - 1,
          columnNumber: origin.columnNumber - 1,
        },
      };
    }),
  );
  return { profile: { ...profile, nodes }, mappedFrames, unmappedFrames };
}

type Interval = { start: number; end: number; forced: boolean };

function isTask(name: string | undefined): boolean {
  return name === "RunTask" || name === "ThreadControllerImpl::RunTask";
}

function unionDuration(intervals: readonly Interval[]): number {
  let total = 0;
  let end = -Infinity;
  for (const interval of intervals.toSorted((left, right) => left.start - right.start)) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}

export function summarizeColdLoadTrace(events: readonly ColdLoadTraceEvent[], durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Cold-load trace duration must be positive");
  }
  const navigation = events.find(
    (event) => event.name === "navigationStart" && event.args?.data?.isLoadingMainFrame !== false,
  );
  const rendererThreads = events.filter(
    (event) =>
      event.name === "thread_name" &&
      event.args?.name === "CrRendererMain" &&
      (!navigation || event.pid === navigation.pid),
  );
  const candidates = rendererThreads.length
    ? rendererThreads
    : events.filter((event) => isTask(event.name) && (!navigation || event.pid === navigation.pid));
  const taskCounts = new Map<string, number>();
  for (const event of events) {
    if (isTask(event.name) && event.ph !== "E") {
      const key = `${event.pid}:${event.tid}`;
      taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
    }
  }
  const renderer = candidates.toSorted(
    (left, right) =>
      (taskCounts.get(`${right.pid}:${right.tid}`) ?? 0) -
      (taskCounts.get(`${left.pid}:${left.tid}`) ?? 0),
  )[0];
  if (!renderer) {
    throw new Error("Cold-load trace has no renderer main-thread tasks");
  }
  const threadEvents = events.filter(
    (event) => event.pid === renderer.pid && event.tid === renderer.tid,
  );
  const firstTask = threadEvents.find((event) => isTask(event.name) && event.ph !== "E");
  const start = navigation?.ts ?? firstTask?.ts;
  if (start === undefined) {
    throw new Error("Cold-load trace has no navigation or task start");
  }
  const end = start + durationMs * 1_000;
  const canonicalTask = threadEvents.some((event) => event.name === "RunTask")
    ? "RunTask"
    : "ThreadControllerImpl::RunTask";
  const tasks: Interval[] = [];
  const layouts: Interval[] = [];
  const stack: ColdLoadTraceEvent[] = [];
  const add = (event: ColdLoadTraceEvent, finish: number) => {
    const interval = {
      start: Math.max(start, event.ts),
      end: Math.min(end, finish),
      forced: Boolean(event.args?.beginData?.stackTrace?.length),
    };
    if (interval.end > interval.start) {
      if (event.name === canonicalTask) {
        tasks.push(interval);
      } else if (event.name === "Layout") {
        layouts.push(interval);
      }
    }
  };
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
  const longTasks = tasks.filter((task) => task.end - task.start >= 50_000);
  const forcedLayouts = layouts.filter((layout) => layout.forced);
  return {
    durationMs,
    navigationStartUs: start,
    navigationStartFound: navigation !== undefined,
    rendererPid: renderer.pid,
    rendererTid: renderer.tid,
    busyMs: unionDuration(tasks) / 1_000,
    longTasks: longTasks.length,
    longTaskMs: unionDuration(longTasks) / 1_000,
    longestTaskMs: Math.max(0, ...tasks.map((task) => (task.end - task.start) / 1_000)),
    layoutCount: layouts.length,
    layoutMs: unionDuration(layouts) / 1_000,
    forcedLayouts: forcedLayouts.length,
    forcedLayoutMs: unionDuration(forcedLayouts) / 1_000,
  };
}

export function summarizeCpuProfile(
  profile: ColdLoadCpuProfile,
  options: { isSolidFlush?: (frame: ColdLoadCpuFrame) => boolean } = {},
) {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length !== deltas.length || samples.length === 0) {
    throw new Error("Cold-load CPU profile needs matching samples and time deltas");
  }
  let timestamp = 0;
  let outOfOrderSamples = 0;
  const timedSamples = samples
    .map((id, index) => {
      const delta = deltas[index]!;
      if (!Number.isFinite(delta)) {
        throw new Error("Cold-load CPU profile has an invalid sample time");
      }
      if (delta < 0) {
        outOfOrderSamples++;
      }
      timestamp += delta;
      if (timestamp < 0) {
        throw new Error("Cold-load CPU sample precedes the profile start");
      }
      return { id, timestamp };
    })
    .toSorted((left, right) => left.timestamp - right.timestamp);
  // Chrome can report native/JS samples out of order; signed deltas retain their timestamps.
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const parents = new Map<number, number>(
    profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id])),
  );
  const totals = new Map<
    string,
    ColdLoadCpuFrame & { selfMs: number; samples: number; callSite?: ColdLoadCpuFrame }
  >();
  const isSolidFlush =
    options.isSolidFlush ??
    ((frame: ColdLoadCpuFrame) =>
      /(?:solid-js|@solidjs|solid-runtime)/u.test(frame.url) &&
      /^(?:flush|runUpdates|runEffects)$/u.test(frame.functionName));
  let sampledMs = 0;
  let idleMs = 0;
  let solidFlushSelfMs = 0;
  let solidFlushInclusiveMs = 0;
  const solidFlushIds = new Set(
    profile.nodes.filter((node) => isSolidFlush(node.callFrame)).map((node) => node.id),
  );
  let previousTimestamp = 0;
  for (const sample of timedSamples) {
    const frame = nodes.get(sample.id);
    const delta = sample.timestamp - previousTimestamp;
    previousTimestamp = sample.timestamp;
    if (!frame) {
      throw new Error("Cold-load CPU profile has an invalid sample");
    }
    const selfMs = delta / 1_000;
    sampledMs += selfMs;
    if (frame.functionName === "(idle)") {
      idleMs += selfMs;
    }
    if (isSolidFlush(frame)) {
      solidFlushSelfMs += selfMs;
    }
    let ancestor: number | undefined = sample.id;
    while (ancestor !== undefined) {
      if (solidFlushIds.has(ancestor)) {
        // Count each sample once even when flush calls are nested.
        solidFlushInclusiveMs += selfMs;
        break;
      }
      ancestor = parents.get(ancestor);
    }
    if (frame.functionName === "(root)" || frame.functionName === "(idle)") {
      continue;
    }
    let callSite: ColdLoadCpuFrame | undefined;
    if (!frame.url) {
      let caller = parents.get(sample.id);
      while (caller !== undefined) {
        const candidate = nodes.get(caller);
        if (candidate?.url) {
          callSite = candidate;
          break;
        }
        caller = parents.get(caller);
      }
    }
    const key = JSON.stringify([
      callSite,
      frame.functionName,
      frame.url,
      frame.lineNumber,
      frame.columnNumber,
    ]);
    const total = totals.get(key) ?? {
      ...frame,
      ...(callSite ? { callSite } : {}),
      selfMs: 0,
      samples: 0,
    };
    total.selfMs += selfMs;
    total.samples += 1;
    totals.set(key, total);
  }
  return {
    sampledMs,
    idleMs,
    outOfOrderSamples,
    // Bundled/minified frames need the runner's source-map-informed matcher.
    solidFlushSelfMs: solidFlushIds.size ? solidFlushSelfMs : null,
    solidFlushInclusiveMs: solidFlushIds.size ? solidFlushInclusiveMs : null,
    hotspots: [...totals.values()]
      .toSorted((left, right) => right.selfMs - left.selfMs)
      .slice(0, 20),
  };
}
