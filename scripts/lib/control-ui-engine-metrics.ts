import type { Page } from "playwright";

export type ControlUiEngine = "chromium" | "webkit";

export type EngineMetrics = {
  collection: "cdp-performance" | "webkit-inspector" | "untraced";
  timeDomain: "threadTicks" | "monotonic-wall";
  scriptMs: number | null;
  taskMs: number | null;
  layoutMs: number | null;
  styleMs: number | null;
  layoutCount: number | null;
  styleCount: number | null;
  jsHeapUsedBytes: number | null;
  cpuMs: number | null;
  sampledCpu?: { coveredMs: number; meanUsagePercent: number; sampleCount: number };
  notes: string[];
};

type WebKitRecord = {
  type: string;
  startTime: number;
  endTime?: number;
  children?: WebKitRecord[];
  [key: string]: unknown;
};
type WebKitScriptEvent = { startTime: number; endTime: number; type: string };
type WebKitCpuEvent = {
  timestamp: number;
  usage: number;
  threads?: Array<{ name: string; usage: number; type?: string; targetId?: string }>;
};
type WebKitEvents = {
  "Timeline.eventRecorded": { record: WebKitRecord };
  "ScriptProfiler.trackingUpdate": { event: WebKitScriptEvent };
  "ScriptProfiler.trackingComplete": { timestamp: number; samples?: unknown };
  "CPUProfiler.trackingUpdate": { event: WebKitCpuEvent };
};
type WebKitSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on<K extends keyof WebKitEvents>(name: K, listener: (event: WebKitEvents[K]) => void): void;
  off<K extends keyof WebKitEvents>(name: K, listener: (event: WebKitEvents[K]) => void): void;
};
type WebKitPage = {
  _connection?: {
    toImpl?(page: Page): { delegate?: { _session?: WebKitSession } };
  };
};

export type EngineMeasurement = {
  metrics: EngineMetrics;
  timeline?: unknown[];
  profile?: unknown;
  cpuSamples?: WebKitCpuEvent[];
};

type MeasurementOptions = { trace: boolean; cpuOnly?: boolean };

/** Union nested same-category records so recursive calls are counted once. */
function intervalMilliseconds(intervals: Array<{ startTime: number; endTime: number }>) {
  let total = 0;
  let end = -Infinity;
  for (const interval of intervals.toSorted((a, b) => a.startTime - b.startTime)) {
    if (interval.endTime > end) {
      total += interval.endTime - Math.max(end, interval.startTime);
      end = interval.endTime;
    }
  }
  return total * 1_000;
}

async function startWebKitMeasurement(page: Page, trace: boolean) {
  // SAFETY: Playwright 1.64.1 has no public WebKit inspector session. This
  // validated private contract uses its existing in-process pipe; absent
  // shapes fail explicitly below, and a changed target fails at stop.
  // eslint-disable-next-line no-underscore-dangle -- The pinned Playwright in-process bridge is the WebKit inspector transport.
  const implementation = (page as Page & WebKitPage)._connection?.toImpl?.(page);
  // eslint-disable-next-line no-underscore-dangle -- WKPage owns this exact inspector session; no extra attachment is created.
  const session = implementation?.delegate?._session;
  if (!session) {
    throw new Error(
      "WebKit metrics require Playwright's in-process WKSession (validated on 1.64.1)",
    );
  }
  const records: WebKitRecord[] = [];
  const scriptEvents: WebKitScriptEvent[] = [];
  const cpuSamples: WebKitCpuEvent[] = [];
  let samples: unknown;
  const record = ({ record: entry }: WebKitEvents["Timeline.eventRecorded"]) => records.push(entry);
  const script = ({ event }: WebKitEvents["ScriptProfiler.trackingUpdate"]) =>
    scriptEvents.push(event);
  const complete = (event: WebKitEvents["ScriptProfiler.trackingComplete"]) => {
    samples = event.samples;
  };
  const cpu = ({ event }: WebKitEvents["CPUProfiler.trackingUpdate"]) => cpuSamples.push(event);
  session.on("Timeline.eventRecorded", record);
  session.on("ScriptProfiler.trackingUpdate", script);
  session.on("ScriptProfiler.trackingComplete", complete);
  session.on("CPUProfiler.trackingUpdate", cpu);
  const detach = () => {
    session.off("Timeline.eventRecorded", record);
    session.off("ScriptProfiler.trackingUpdate", script);
    session.off("ScriptProfiler.trackingComplete", complete);
    session.off("CPUProfiler.trackingUpdate", cpu);
  };
  const started: string[] = [];
  let timelineEnabled = false;
  try {
    if (trace) {
      await session.send("Timeline.enable");
      timelineEnabled = true;
      await session.send("Timeline.start", { maxCallStackDepth: 20 });
      started.push("Timeline.stop");
      await session.send("ScriptProfiler.startTracking", { includeSamples: true });
      started.push("ScriptProfiler.stopTracking");
    }
    await session.send("CPUProfiler.startTracking");
    started.push("CPUProfiler.stopTracking");
  } catch (error) {
    await Promise.allSettled(started.map((method) => session.send(method)));
    if (timelineEnabled) {
      await session.send("Timeline.disable");
    }
    detach();
    throw error;
  }
  return {
    async stop(): Promise<EngineMeasurement> {
      let stopped = false;
      try {
        // The local HTTP initial navigation/reload retains its target in the
        // pinned build. Fail on a process swap rather than report partial boot.
        // eslint-disable-next-line no-underscore-dangle -- A target swap invalidates this private-session measurement.
        if (implementation?.delegate?._session !== session) {
          throw new Error("WebKit target changed during measurement; metrics would be incomplete");
        }
        for (const method of started) {
          await session.send(method);
        }
        stopped = true;
        const flattened: WebKitRecord[] = [];
        const visit = (entry: WebKitRecord) => {
          flattened.push(entry);
          entry.children?.forEach(visit);
        };
        records.forEach(visit);
        const category = (name: string) =>
          flattened.filter(
            (entry): entry is WebKitRecord & { endTime: number } =>
              entry.type === name && entry.endTime !== undefined,
          );
        const layout = category("Layout");
        const style = category("RecalculateStyles");
        // ResourceUsageThread samples at a coarse interval. Discard the first
        // sample's unknown preceding interval; keep only observed inner spans.
        let coveredMs = 0;
        let sampledCpuMs = 0;
        for (let index = 1; index < cpuSamples.length; index++) {
          const duration =
            (cpuSamples[index]!.timestamp - cpuSamples[index - 1]!.timestamp) * 1_000;
          coveredMs += duration;
          sampledCpuMs += (duration * cpuSamples[index]!.usage) / 100;
        }
        const sampledCpu =
          coveredMs >= 1_000
            ? {
                coveredMs,
                meanUsagePercent: (sampledCpuMs / coveredMs) * 100,
                sampleCount: cpuSamples.length,
              }
            : undefined;
        return {
          metrics: {
            collection: "webkit-inspector",
            timeDomain: "monotonic-wall",
            scriptMs: trace ? intervalMilliseconds(scriptEvents) : null,
            taskMs: null,
            layoutMs: trace ? intervalMilliseconds(layout) : null,
            styleMs: trace ? intervalMilliseconds(style) : null,
            layoutCount: trace ? layout.length : null,
            styleCount: trace ? style.length : null,
            jsHeapUsedBytes: null,
            cpuMs: sampledCpu ? sampledCpuMs : null,
            ...(sampledCpu ? { sampledCpu } : {}),
            notes: [
              ...(trace
                ? [
                    "WebKit ScriptProfiler and Timeline report elapsed monotonic wall time, not thread CPU. Script intervals include native work invoked by JavaScript and Playwright automation.",
                    "Timeline/ScriptProfiler and stack sampling add overhead. Compare timings in separate untraced runs.",
                  ]
                : [
                    "CPU-only collection omits Timeline and ScriptProfiler; their counters are null.",
                  ]),
              "CPUProfiler samples are process/thread usage percentages, not cumulative CPU time. cpuMs is an estimate over sampledCpu.coveredMs only when that interior span is at least 1 s; boundary intervals are excluded. Short spans, task and heap counters are null. Do not compare WebKit wall durations with Chromium threadTicks as CPU ratios.",
            ],
          },
          ...(trace ? { timeline: records, profile: { scriptEvents, samples, cpuSamples } } : {}),
          cpuSamples,
        };
      } finally {
        if (!stopped) {
          await Promise.allSettled(started.map((method) => session.send(method)));
        }
        try {
          if (timelineEnabled) {
            await session.send("Timeline.disable");
          }
        } finally {
          detach();
        }
      }
    },
  };
}

/** Start immediately before the measured action, stop after its visible result. */
export async function startEngineMeasurement(
  page: Page,
  engine: ControlUiEngine,
  options: MeasurementOptions,
) {
  if (engine === "webkit") {
    if (!options.trace && !options.cpuOnly) {
      // Inspector instrumentation has measurable cost. Keep cross-engine wall
      // comparisons untraced; collect attribution in a separate --trace run.
      return {
        async stop(): Promise<EngineMeasurement> {
          return {
            metrics: {
              collection: "untraced",
              timeDomain: "monotonic-wall",
              scriptMs: null,
              taskMs: null,
              layoutMs: null,
              styleMs: null,
              layoutCount: null,
              styleCount: null,
              jsHeapUsedBytes: null,
              cpuMs: null,
              notes: [
                "WebKit has no public untraced script/layout/heap counters. Use a separate --trace run for Inspector attribution; these missing metrics are not zero.",
              ],
            },
          };
        },
      };
    }
    return startWebKitMeasurement(page, options.trace);
  }
  const session = await page.context().newCDPSession(page);
  const timeline: unknown[] = [];
  try {
    await session.send("Performance.enable", { timeDomain: "threadTicks" });
    if (options.trace) {
      session.on("Tracing.dataCollected", ({ value }) => timeline.push(...value));
      await session.send("Tracing.start", {
        categories: "toplevel,blink.user_timing,devtools.timeline",
        transferMode: "ReportEvents",
      });
      await session.send("Profiler.enable");
      await session.send("Profiler.start");
    }
    const read = async () => {
      const { metrics } = await session.send("Performance.getMetrics");
      return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    };
    const before = await read();
    return {
      async stop(): Promise<EngineMeasurement> {
        try {
          const after = await read();
          const delta = (key: string, factor = 1_000) => {
            const previous = before[key];
            const current = after[key];
            if (
              previous === undefined ||
              current === undefined ||
              !Number.isFinite(previous) ||
              !Number.isFinite(current)
            ) {
              throw new Error(`Missing Chromium metric: ${key}`);
            }
            if (current < previous) {
              throw new Error(`Chromium ${key} reset during measurement; interval is invalid`);
            }
            return (current - previous) * factor;
          };
          let profile: unknown;
          if (options.trace) {
            profile = (await session.send("Profiler.stop")).profile;
            const complete = new Promise<void>((resolve) => {
              session.once("Tracing.tracingComplete", () => resolve());
            });
            await session.send("Tracing.end");
            await complete;
          }
          return {
            metrics: {
              collection: "cdp-performance",
              timeDomain: "threadTicks",
              scriptMs: delta("ScriptDuration"),
              taskMs: delta("TaskDuration"),
              layoutMs: delta("LayoutDuration"),
              styleMs: delta("RecalcStyleDuration"),
              layoutCount: delta("LayoutCount", 1),
              styleCount: delta("RecalcStyleCount", 1),
              jsHeapUsedBytes: after.JSHeapUsedSize ?? null,
              cpuMs: delta("TaskDuration"),
              notes: [
                "Chromium Performance threadTicks records renderer main-thread CPU. cpuMs is TaskDuration, not total renderer-process CPU.",
                ...(options.trace ? ["Tracing and V8 sampling add instrumentation overhead."] : []),
              ],
            },
            ...(options.trace ? { timeline, profile } : {}),
          };
        } finally {
          await session.detach();
        }
      },
    };
  } catch (error) {
    await session.detach();
    throw error;
  }
}
