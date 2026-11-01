import { readFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function controlUiScriptAssetUrl(value: string, assets: URL): URL | null {
  const url = URL.parse(value);
  return url &&
    url.origin === assets.origin &&
    url.pathname.includes(assets.pathname) &&
    /\.m?js$/u.test(url.pathname)
    ? url
    : null;
}

/** V8 offsets are UTF-16; nested block counts override their containing function. */
export function summarizeScriptCoverage(entry: {
  source?: string;
  functions: readonly {
    ranges: readonly { startOffset: number; endOffset: number; count: number }[];
  }[];
}) {
  const source = entry.source ?? "";
  const executed = new Uint8Array(source.length);
  const ranges = entry.functions
    .flatMap((fn) => fn.ranges)
    .toSorted(
      (left, right) => right.endOffset - right.startOffset - (left.endOffset - left.startOffset),
    );
  for (const range of ranges) {
    executed.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
  }
  let executedBytes = 0;
  let start = 0;
  for (let index = 0; index <= source.length; index++) {
    if (!executed[index]) {
      executedBytes += Buffer.byteLength(source.slice(start, index));
      start = index + 1;
    }
  }
  const loadedBytes = Buffer.byteLength(source);
  return { loadedBytes, executedBytes, unusedBytes: loadedBytes - executedBytes };
}

/** Resource Timing includes completed modulepreloads, even without V8 coverage. */
export function summarizeJavaScriptResources(
  resources: readonly {
    url: string;
    decodedBytes: number;
    encodedBytes: number;
    transferBytes: number;
  }[],
  coverage?: readonly { url: string }[],
) {
  const scripts = resources.filter((entry) =>
    /\.m?js$/u.test(URL.parse(entry.url)?.pathname ?? ""),
  );
  const sum = (entries: typeof scripts) => ({
    requests: entries.length,
    rawBytes: entries.reduce((total, entry) => total + entry.decodedBytes, 0),
    encodedBytes: entries.reduce((total, entry) => total + entry.encodedBytes, 0),
    transferBytes: entries.reduce((total, entry) => total + entry.transferBytes, 0),
  });
  const observed = coverage && new Set(coverage.map((entry) => entry.url));
  return {
    ...sum(scripts),
    outsideCoverage: observed
      ? sum(scripts.filter((entry) => !observed.has(entry.url)))
      : undefined,
  };
}

export type ColdLoadTraceEvent = {
  name?: string;
  ph: string;
  ts: number;
  dur?: number;
  tts?: number;
  tdur?: number;
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
    (event.dur !== undefined && typeof event.dur !== "number") ||
    (event.tts !== undefined && typeof event.tts !== "number") ||
    (event.tdur !== undefined && typeof event.tdur !== "number")
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
    tts: event.tts,
    tdur: event.tdur,
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
      const url = controlUiScriptAssetUrl(frame.url, base);
      if (!url || frame.lineNumber < 0) {
        return node;
      }
      // Preview also serves relative entry assets beneath the deep-link path.
      const assetStart = url.pathname.lastIndexOf(base.pathname);
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
      const origin = map.findEntry(frame.lineNumber, frame.columnNumber);
      if (
        !("originalSource" in origin) ||
        typeof origin.originalSource !== "string" ||
        origin.generatedLine !== frame.lineNumber
      ) {
        unmappedFrames += 1;
        return node;
      }
      mappedFrames += 1;
      // Node's SourceMapping declarations omit the optional decoded name.
      const name = asRecord(origin)?.name;
      const source = origin.originalSource;
      return {
        ...node,
        callFrame: {
          functionName: typeof name === "string" && name ? name : frame.functionName,
          // Resolve map-relative paths before comparing functions across build directories.
          url:
            URL.canParse(source) && !path.isAbsolute(source)
              ? source
              : path
                  .relative(repositoryRoot, path.resolve(path.dirname(file), source))
                  .split(path.sep)
                  .join("/"),
          lineNumber: origin.originalLine,
          columnNumber: origin.originalColumn,
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

function unionDuration(intervals: readonly Pick<Interval, "start" | "end">[]): number {
  let total = 0;
  let end = -Infinity;
  for (const interval of intervals.toSorted((left, right) => left.start - right.start)) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}

/** Coarse V8 parse/compile spans in the capture; not an exhaustive compiler profile. */
function summarizeCompilationTrace(
  events: readonly ColdLoadTraceEvent[],
  renderer: { pid: number; tid: number },
  start: number,
  end: number,
) {
  const intervals: {
    tid: number;
    wall: { start: number; end: number };
    cpu?: { start: number; end: number };
  }[] = [];
  const names = new Map<string, number>();
  const stacks = new Map<number, ColdLoadTraceEvent[]>();
  const add = (event: ColdLoadTraceEvent, finish: number, cpuFinish?: number) => {
    // Exclude JSON parsing and compile-wait spans, which are not compiler work.
    if (
      !event.name ||
      !/^(?:v8\.compile(?:Module)?|v8\.parseOnBackground|v8\.deserializeOnBackground|V8\.(?:Compile|Parse(?:Program|Function|Lazy)|DeserializeCode))/u.test(
        event.name,
      ) ||
      /Wait/u.test(event.name)
    ) {
      return;
    }
    const wall = { start: Math.max(start, event.ts), end: Math.min(end, finish) };
    if (wall.end <= wall.start) {
      return;
    }
    // Thread clocks cannot be clipped proportionally to wall time on a loaded host.
    const cpu =
      event.ts >= start && finish <= end && event.tts !== undefined && cpuFinish !== undefined
        ? { start: event.tts, end: cpuFinish }
        : undefined;
    intervals.push({ tid: event.tid, wall, cpu });
    names.set(event.name, (names.get(event.name) ?? 0) + 1);
  };
  for (const event of events) {
    if (event.pid !== renderer.pid) {
      continue;
    }
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
  const summarize = (tid?: number) => {
    const selected = intervals.filter((interval) => tid === undefined || interval.tid === tid);
    const threads = [...new Set(selected.map((interval) => interval.tid))];
    return {
      events: selected.length,
      // Union nested events per thread; parallel threads contribute independent work.
      wallMs:
        threads.reduce(
          (total, thread) =>
            total +
            unionDuration(
              selected
                .filter((interval) => interval.tid === thread)
                .map((interval) => interval.wall),
            ),
          0,
        ) / 1_000,
      threadCpuMs:
        selected.length && selected.every((interval) => interval.cpu !== undefined)
          ? threads.reduce(
              (total, thread) =>
                total +
                unionDuration(
                  selected
                    .filter((interval) => interval.tid === thread)
                    .map((interval) => interval.cpu!),
                ),
              0,
            ) / 1_000
          : null,
    };
  };
  return {
    mainThread: summarize(renderer.tid),
    allRendererThreads: summarize(),
    eventNames: [...names]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count })),
  };
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
    longTaskIntervals: longTasks.map((task) => ({
      startUs: task.start,
      endUs: task.end,
      durationMs: (task.end - task.start) / 1_000,
    })),
    longestTaskMs: Math.max(0, ...tasks.map((task) => (task.end - task.start) / 1_000)),
    layoutCount: layouts.length,
    layoutMs: unionDuration(layouts) / 1_000,
    forcedLayouts: forcedLayouts.length,
    forcedLayoutMs: unionDuration(forcedLayouts) / 1_000,
    compilation: summarizeCompilationTrace(events, renderer, start, end),
  };
}

export function summarizeCpuProfile(
  profile: ColdLoadCpuProfile,
  options: { isSolidFlush?: (frame: ColdLoadCpuFrame) => boolean; includeTables?: boolean } = {},
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
  const functions = new Map<string, ColdLoadCpuFunction>();
  const files = new Map<string, number>();
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
    if (options.includeTables) {
      const seenFunctions = new Set<string>();
      const seenFiles = new Set<string>();
      let current: number | undefined = sample.id;
      while (current !== undefined) {
        const entry = nodes.get(current)!;
        if (entry.functionName !== "(root)" && entry.functionName !== "(idle)") {
          const key = functionKey(entry);
          const row = functions.get(key) ?? {
            functionName: entry.functionName,
            url: entry.url,
            lineNumber: entry.lineNumber,
            columnNumber: entry.columnNumber,
            selfMs: 0,
            inclusiveMs: 0,
          };
          if (current === sample.id) {
            row.selfMs += selfMs;
          }
          if (!seenFunctions.has(key)) {
            row.inclusiveMs += selfMs;
          }
          functions.set(key, row);
          seenFunctions.add(key);
          if (entry.url && !seenFiles.has(entry.url)) {
            files.set(entry.url, (files.get(entry.url) ?? 0) + selfMs);
            seenFiles.add(entry.url);
          }
        }
        current = parents.get(current);
      }
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
    tables: options.includeTables
      ? {
          functions: [...functions.values()],
          files: [...files].map(([url, inclusiveMs]) => ({ url, inclusiveMs })),
        }
      : undefined,
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

export type ColdLoadCpuFunction = ColdLoadCpuFrame & { selfMs: number; inclusiveMs: number };
export type ColdLoadCpuTables = {
  functions: ColdLoadCpuFunction[];
  files: { url: string; inclusiveMs: number }[];
};

function functionKey(row: ColdLoadCpuFrame) {
  return JSON.stringify([row.url, row.functionName, row.lineNumber, row.columnNumber]);
}

export function medianCpuTables(tables: ColdLoadCpuTables[]): ColdLoadCpuTables {
  const median = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return (
      (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
    );
  };
  const functions = tables.map(
    (table) => new Map(table.functions.map((row) => [functionKey(row), row])),
  );
  const files = tables.map(
    (table) => new Map(table.files.map((row) => [row.url, row.inclusiveMs])),
  );
  return {
    functions: [
      ...new Map(
        tables.flatMap((table) => table.functions.map((row) => [functionKey(row), row])),
      ).entries(),
    ].map(([key, row]) =>
      Object.assign({}, row, {
        selfMs: median(functions.map((rows) => rows.get(key)?.selfMs ?? 0)),
        inclusiveMs: median(functions.map((rows) => rows.get(key)?.inclusiveMs ?? 0)),
      }),
    ),
    files: [...new Set(tables.flatMap((table) => table.files.map((row) => row.url)))].map(
      (url) => ({
        url,
        inclusiveMs: median(files.map((rows) => rows.get(url) ?? 0)),
      }),
    ),
  };
}

export function compareCpuTables(baseline: ColdLoadCpuTables, candidate: ColdLoadCpuTables) {
  const before = new Map(baseline.functions.map((row) => [functionKey(row), row]));
  const after = new Map(candidate.functions.map((row) => [functionKey(row), row]));
  return [...new Map([...before, ...after])].map(([key, row]) =>
    Object.assign({}, row, {
      baselineSelfMs: before.get(key)?.selfMs ?? 0,
      baselineInclusiveMs: before.get(key)?.inclusiveMs ?? 0,
      selfMs: (after.get(key)?.selfMs ?? 0) - (before.get(key)?.selfMs ?? 0),
      inclusiveMs: (after.get(key)?.inclusiveMs ?? 0) - (before.get(key)?.inclusiveMs ?? 0),
    }),
  );
}

export function formatCpuTables(title: string, tables: ColdLoadCpuTables, comparison = false) {
  const appFirst = (url: string) =>
    Boolean(url && !url.includes("node_modules") && !URL.canParse(url));
  const format = (value: number) =>
    `${comparison && value > 0 ? "+" : ""}${value.toFixed(1)}`.padStart(10);
  const rows = (metric: "selfMs" | "inclusiveMs") =>
    tables.functions
      .toSorted(
        (a, b) =>
          Number(appFirst(b.url)) - Number(appFirst(a.url)) ||
          Math.abs(b[metric]) - Math.abs(a[metric]) ||
          functionKey(a).localeCompare(functionKey(b)),
      )
      .slice(0, 70)
      .map(
        (row) =>
          `${format(row[metric])}  ${row.url || "(native)"}:${row.lineNumber + 1}:${row.columnNumber + 1} ${row.functionName || "(anonymous)"}`,
      )
      .join("\n");
  return [
    title,
    `${comparison ? "Delta " : ""}self ms (app sources first)`,
    rows("selfMs"),
    `${comparison ? "Delta " : ""}inclusive ms by function (app sources first)`,
    rows("inclusiveMs"),
    ...(comparison
      ? []
      : [
          "Inclusive ms by source file",
          tables.files
            .toSorted((a, b) => b.inclusiveMs - a.inclusiveMs)
            .slice(0, 45)
            .map((row) => `${format(row.inclusiveMs)}  ${row.url}`)
            .join("\n"),
        ]),
  ].join("\n");
}

const cpuTablesSchema = z.object({
  functions: z.array(
    z.object({
      functionName: z.string(),
      url: z.string(),
      lineNumber: z.number().int(),
      columnNumber: z.number().int(),
      selfMs: z.number().nonnegative().finite(),
      inclusiveMs: z.number().nonnegative().finite(),
    }),
  ),
  files: z.array(z.object({ url: z.string(), inclusiveMs: z.number().nonnegative().finite() })),
});

export function readCpuProfileReport(
  value: unknown,
  phases: string[],
): Record<string, ColdLoadCpuTables> {
  const report = z.record(z.string(), cpuTablesSchema).parse(value);
  const baseline = Object.keys(report).toSorted().join(", ");
  const candidate = phases.toSorted().join(", ");
  if (baseline !== candidate) {
    throw new Error(`CPU profile phases differ: baseline [${baseline}], candidate [${candidate}]`);
  }
  return report;
}
