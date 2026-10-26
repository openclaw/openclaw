// Private benchmark preload: timing runs never request GC or enable an inspector sampler.
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  createHistogram,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry,
  type RecordableHistogram,
} from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { getHeapSnapshot, getHeapSpaceStatistics } from "node:v8";
import { isMainThread } from "node:worker_threads";

type Options = {
  output: string;
  allocations: boolean;
  retention?: boolean;
  intervalMs?: number;
};
type GcMetric = { count: number; totalMs: number; maxMs: number; pauses: RecordableHistogram };
type StallMetric = { count: number; totalMs: number; maxMs: number };

function gcKind(entry: PerformanceEntry) {
  const detail = "detail" in entry ? entry.detail : undefined;
  const kind = detail && typeof detail === "object" && "kind" in detail ? detail.kind : null;
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MAJOR:
      return "major";
    case constants.NODE_PERFORMANCE_GC_MINOR:
      return "minor";
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return "incremental";
    case constants.NODE_PERFORMANCE_GC_WEAKCB:
      return "weakCallback";
    default:
      return "unknown";
  }
}

function addGc(metrics: Map<string, GcMetric>, kind: string, durationMs: number) {
  let metric = metrics.get(kind);
  if (!metric) {
    metric = { count: 0, totalMs: 0, maxMs: 0, pauses: createHistogram() };
    metrics.set(kind, metric);
  }
  metric.count++;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  metric.pauses.record(Math.max(1, Math.round(durationMs * 1_000)));
}

function summarizeGc(metrics: Map<string, GcMetric>, durationMs: number) {
  return Object.fromEntries(
    [...metrics].map(([kind, metric]) => [
      kind,
      {
        count: metric.count,
        totalMs: metric.totalMs,
        secondsPerMinute: (metric.totalMs * 60) / durationMs,
        p95Ms: metric.pauses.percentile(95) / 1_000,
        p99Ms: metric.pauses.percentile(99) / 1_000,
        maxMs: metric.maxMs,
      },
    ]),
  );
}

function allocationBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);
}

async function saveSamplingProfile(inspector: Session, output: string, retention: boolean) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await writeFile(
    path.join(output, retention ? "stress-retention.heapprofile" : "stress-allocation.heapprofile"),
    JSON.stringify(profile),
    { flag: "wx", mode: 0o600 },
  );
  return allocationBytes(profile.head);
}

async function captureRetainedHeap(inspector: Session, output: string, measuredEnd: number) {
  const checkpoint = () => ({
    atEpochMs: performance.timeOrigin + performance.now(),
    memory: process.memoryUsage(),
    heapSpaces: getHeapSpaceStatistics(),
  });
  const beforeCollection = checkpoint();
  await inspector.post("HeapProfiler.collectGarbage");
  const afterCollection = checkpoint();
  const heapSnapshot = "stress-retained.heapsnapshot";
  // This runs after timing and sampling stop. Streaming avoids a second JS heap copy.
  await pipeline(
    getHeapSnapshot(),
    createWriteStream(path.join(output, heapSnapshot), { flags: "wx", mode: 0o600 }),
  );
  await writeFile(
    path.join(output, "stress-retention.json"),
    JSON.stringify(
      {
        measuredWindowEndedAtEpochMs: measuredEnd,
        beforeCollection,
        afterCollection,
        afterSnapshot: checkpoint(),
        heapSnapshot,
        scope:
          "Main isolate; explicit full GC and heap snapshot after the measured window. Snapshot generation can itself collect garbage; its cost is excluded from timing.",
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
}

/** CPU is the main OS thread; memory is main-isolate heap plus process-wide RSS. */
export async function startTeamStressTelemetry(options: Options) {
  if (!isMainThread) {
    throw new Error("Team stress telemetry must run in the Gateway main isolate");
  }
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
    throw new Error("Telemetry interval must be an integer >= 100 ms");
  }
  if (options.retention && !options.allocations) {
    throw new Error("Retention diagnostics require allocation sampling");
  }
  await mkdir(options.output, { recursive: true });
  const minutePath = path.join(options.output, "stress-minutes.jsonl");
  await writeFile(minutePath, "", { flag: "wx", mode: 0o600 });
  const inspector = options.allocations ? new Session() : undefined;
  const samplingOptions = {
    samplingInterval: 512 * 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: !options.retention,
  };
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", samplingOptions);
  }
  const mode = options.retention
    ? "retention-diagnostic"
    : inspector
      ? "allocation-diagnostic"
      : "untraced-timing";
  const initialMemory = process.memoryUsage();
  const initialHeapSpaces = getHeapSpaceStatistics();
  const started = performance.now();
  let windowStarted = started;
  const initialCpu = process.threadCpuUsage();
  let previousCpu = initialCpu;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  const allLoop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  allLoop.enable();
  const totalGc = new Map<string, GcMetric>();
  let windowGc = new Map<string, GcMetric>();
  const totalStalls: StallMetric = { count: 0, totalMs: 0, maxMs: 0 };
  let windowStalls: StallMetric = { count: 0, totalMs: 0, maxMs: 0 };
  const collectGc = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime < started) {
        continue;
      }
      const kind = gcKind(entry);
      addGc(windowGc, kind, entry.duration);
      addGc(totalGc, kind, entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => collectGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  let expectedTick = performance.now() + 20;
  const stallTimer = setInterval(() => {
    const now = performance.now();
    const excessMs = now - expectedTick;
    expectedTick = now + 20;
    if (excessMs > 100) {
      for (const metric of [windowStalls, totalStalls]) {
        metric.count++;
        metric.totalMs += excessMs;
        metric.maxMs = Math.max(metric.maxMs, excessMs);
      }
    }
  }, 20).unref();
  let previousAllocatedBytes = 0;
  let windows = 0;
  let failure: Error | undefined;
  let stopped: ReturnType<typeof finish> | undefined;
  let lastSample: { memory: NodeJS.MemoryUsage } | undefined;
  const sample = async (partial: boolean) => {
    collectGc(observer.takeRecords());
    const now = performance.now();
    const durationMs = now - windowStarted;
    const cpu = process.threadCpuUsage();
    const mainThreadCpuMs = (cpu.user + cpu.system - previousCpu.user - previousCpu.system) / 1_000;
    const result = {
      mode,
      pid: process.pid,
      minute: windows++,
      startedAtEpochMs: performance.timeOrigin + windowStarted,
      endedAtEpochMs: performance.timeOrigin + now,
      durationMs,
      partial,
      mainThreadCpuMs,
      mainThreadCpuPercent: (mainThreadCpuMs / durationMs) * 100,
      hostLoadAverage: loadavg(),
      gc: summarizeGc(windowGc, durationMs),
      eventLoop: {
        count: loop.count,
        p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
        p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
        maxMs: loop.count ? loop.max / 1e6 : null,
        resolutionMs: 20,
      },
      stalls: { ...windowStalls, thresholdMs: 100, scope: "20 ms timer excess delay" },
      memory: process.memoryUsage(),
      heapSpaces: getHeapSpaceStatistics(),
      sampledAllocatedBytes: null as number | null,
      sampledAllocatedBytesPerSecond: null as number | null,
      sampledSurvivorBytes: null as number | null,
    };
    loop.reset();
    windowGc = new Map();
    windowStalls = { count: 0, totalMs: 0, maxMs: 0 };
    windowStarted = now;
    previousCpu = cpu;
    if (inspector && !options.retention) {
      // Materializing a sampling profile can force GC; only diagnostic passes enable this.
      const { profile } = await inspector.post("HeapProfiler.getSamplingProfile");
      const cumulative = allocationBytes(profile.head);
      result.sampledAllocatedBytes = cumulative - previousAllocatedBytes;
      result.sampledAllocatedBytesPerSecond = result.sampledAllocatedBytes / (durationMs / 1_000);
      previousAllocatedBytes = cumulative;
    }
    lastSample = result;
    await appendFile(minutePath, `${JSON.stringify(result)}\n`);
  };
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => sample(false))
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
        clearInterval(timer);
      });
  }, intervalMs).unref();
  const stopObserving = () => {
    clearInterval(stallTimer);
    loop.disable();
    allLoop.disable();
    observer.disconnect();
  };
  async function finish() {
    clearInterval(timer);
    await pending;
    let measuredEnd: number | undefined;
    let samplingStopped = false;
    try {
      if (failure) {
        throw failure;
      }
      await sample(true);
      stopObserving();
      const ended = windowStarted;
      const durationMs = ended - started;
      const mainThreadCpuMs =
        (previousCpu.user + previousCpu.system - initialCpu.user - initialCpu.system) / 1_000;
      const summary = {
        mode,
        pid: process.pid,
        startedAtEpochMs: performance.timeOrigin + started,
        endedAtEpochMs: performance.timeOrigin + ended,
        durationMs,
        windows,
        mainThreadCpuMs,
        mainThreadCpuPercent: (mainThreadCpuMs / durationMs) * 100,
        initialMemory,
        initialHeapSpaces,
        samplingOptions: inspector ? samplingOptions : null,
        gc: summarizeGc(totalGc, durationMs),
        eventLoop: {
          count: allLoop.count,
          p95Ms: allLoop.count ? allLoop.percentile(95) / 1e6 : null,
          p99Ms: allLoop.count ? allLoop.percentile(99) / 1e6 : null,
          maxMs: allLoop.count ? allLoop.max / 1e6 : null,
        },
        stalls: totalStalls,
        sampledAllocatedBytes: inspector && !options.retention ? previousAllocatedBytes : null,
        sampledAllocatedBytesPerSecond:
          inspector && !options.retention ? previousAllocatedBytes / (durationMs / 1_000) : null,
        sampledSurvivorBytes: options.retention ? previousAllocatedBytes : null,
        sampledSurvivorBytesPerSecond: options.retention
          ? previousAllocatedBytes / (durationMs / 1_000)
          : null,
        lastSample: lastSample!,
        notes: {
          timing: "Only untraced-timing is suitable for latency/GC comparisons.",
          allocation:
            "V8 estimated sampled JS allocations including collected objects; excludes external/native allocations.",
          retention:
            "Retention sampling excludes minor-collected objects but includes live young objects and major-collected samples. It estimates survivors, not exact promoted bytes; heap snapshots report retained ownership separately.",
          oldGeneration:
            "Native post-major-GC old generation is read from captured Prometheus scrapes, not sampled by this collector.",
        },
      };
      if (inspector && options.retention) {
        // Seal timing before materializing the endpoint profile; no intermediate forced GCs.
        samplingStopped = true;
        summary.sampledSurvivorBytes = await saveSamplingProfile(inspector, options.output, true);
        summary.sampledSurvivorBytesPerSecond = summary.sampledSurvivorBytes / (durationMs / 1_000);
      }
      await writeFile(
        path.join(options.output, "stress-telemetry.json"),
        JSON.stringify(summary, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      measuredEnd = summary.endedAtEpochMs;
      return summary;
    } finally {
      stopObserving();
      if (inspector) {
        try {
          // Release the materialized profile before the retained-heap capture's full GC.
          if (!samplingStopped) {
            await saveSamplingProfile(inspector, options.output, options.retention === true);
          }
          if (options.retention && measuredEnd !== undefined) {
            await captureRetainedHeap(inspector, options.output, measuredEnd);
          }
        } finally {
          inspector.disconnect();
        }
      }
    }
  }
  return () => (stopped ??= finish());
}

/** Installed only by the stress child preload; no public Gateway method is added. */
export function installTeamStressTelemetryIpc() {
  if (!isMainThread || !process.send) {
    throw new Error("Team stress telemetry requires main-isolate private IPC");
  }
  let stop: Awaited<ReturnType<typeof startTeamStressTelemetry>> | undefined;
  let pending = Promise.resolve();
  process.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("channel" in message) ||
      message.channel !== "team-shape-stress" ||
      !("action" in message)
    ) {
      return;
    }
    const action = message.action;
    pending = pending
      .then(async () => {
        if (
          action === "start" &&
          !stop &&
          "output" in message &&
          typeof message.output === "string" &&
          "allocations" in message &&
          typeof message.allocations === "boolean" &&
          (!("retention" in message) || typeof message.retention === "boolean")
        ) {
          stop = await startTeamStressTelemetry({
            output: message.output,
            allocations: message.allocations,
            retention: "retention" in message && message.retention === true,
          });
        } else if (action === "stop" && stop) {
          await stop();
        } else {
          throw new Error("Invalid Team stress telemetry command or lifecycle");
        }
        process.send?.({ channel: "team-shape-stress", action, ok: true });
      })
      .catch((error: unknown) => {
        process.send?.({ channel: "team-shape-stress", action, ok: false, error: String(error) });
      });
  });
  process.once("disconnect", () => {
    void pending.then(() => stop?.()).catch(() => {});
  });
}
