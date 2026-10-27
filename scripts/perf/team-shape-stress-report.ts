// Report only completed real-Gateway captures; missing evidence is never reported as zero cost.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { GatewayResourceSnapshot } from "../lib/gateway-bench-profile.ts";

type RpcSummary = { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
type HeapSpaces = Array<{ space_name: string; space_used_size: number }>;
type Telemetry = {
  mode: string;
  durationMs: number;
  mainThreadCpuPercent: number;
  sampledAllocatedBytesPerSecond: number | null;
  sampledSurvivorBytesPerSecond?: number | null;
  initialHeapSpaces?: HeapSpaces;
  gc: Record<
    string,
    { count: number; totalMs: number; p95Ms: number; p99Ms: number; maxMs: number }
  >;
  eventLoop: { count: number; p95Ms: number | null; p99Ms: number | null; maxMs: number | null };
  stalls: { count: number; totalMs: number; maxMs: number };
  lastSample: { memory: NodeJS.MemoryUsage; heapSpaces?: HeapSpaces };
};
type SoakResult = {
  completedTurns: number;
  worktreeToolChurn?: boolean;
  teamStress: {
    committedWrites: number;
    prometheusScrapes: number;
    rpcMinutes: Array<{ methods: Record<string, { errors: number }> }>;
  };
  memorySamples: Array<{ collectedGarbage: boolean; resources: GatewayResourceSnapshot }>;
  samples: Array<{
    toolCalls: number;
    toolResults: number;
    rpc: Record<string, { latenciesMs: number[] }>;
  }>;
};
type RunOptions = {
  resultDir: string;
  side: "base" | "candidate";
  pair: number;
  mode: string;
  smoke: boolean;
  control?: boolean;
};
export type StressRun = RunOptions & {
  durationMs: number;
  metrics: Record<string, number | null>;
  rpc: Record<string, RpcSummary>;
  gc: Telemetry["gc"];
  stalls: Telemetry["stalls"];
  workerHeaps: GatewayResourceSnapshot["workers"];
  rpcMinutes: SoakResult["teamStress"]["rpcMinutes"];
  nativeOldGenerationSamples: Array<{ scrape: number; bytes: number | null }>;
  memoryScope: string;
};
const MIB = 1024 ** 2;

function oldGenerationBytes(spaces: HeapSpaces | undefined) {
  return spaces
    ?.filter((space) => ["old_space", "large_object_space"].includes(space.space_name))
    .reduce((sum, space) => sum + space.space_used_size, 0);
}

export function summarizeStressRun(options: RunOptions): StressRun {
  const result: SoakResult = JSON.parse(
    readFileSync(path.join(options.resultDir, "result.json"), "utf8"),
  );
  const telemetry: Telemetry = JSON.parse(
    readFileSync(path.join(options.resultDir, "stress-telemetry.json"), "utf8"),
  );
  if (!(telemetry.durationMs >= (options.smoke ? 1 : 600_000))) {
    throw new Error("Stress capture is shorter than the required measured duration");
  }
  if (
    telemetry.mode !==
    (options.mode === "retention"
      ? "retention-diagnostic"
      : options.mode === "allocation"
        ? "allocation-diagnostic"
        : "untraced-timing")
  ) {
    throw new Error("Stress telemetry instrumentation does not match the requested pass");
  }
  const methods = new Map<string, number[]>();
  for (const sample of result.samples) {
    for (const [method, measurement] of Object.entries(sample.rpc)) {
      const latencies = methods.get(method) ?? [];
      latencies.push(...measurement.latenciesMs);
      methods.set(method, latencies);
    }
  }
  const rpc = Object.fromEntries(
    [...methods].map(([method, latencies]) => {
      const sorted = latencies.toSorted((a, b) => a - b);
      const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
      return [
        method,
        {
          count: sorted.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxMs: sorted.at(-1)!,
        },
      ];
    }),
  );
  for (const method of [
    "sessions.list",
    "chat.history",
    "chat.startup",
    "sessions.diff",
    ...(result.worktreeToolChurn ? [] : ["connect"]),
    "chat.inject",
  ]) {
    if (!rpc[method]?.count) {
      throw new Error(`Stress workload did not exercise ${method}`);
    }
  }
  if (
    result.teamStress.rpcMinutes.some((minute) =>
      Object.values(minute.methods).some((method) => method.errors),
    )
  ) {
    throw new Error("Stress workload contains failed RPCs");
  }
  const toolCalls = result.samples.reduce((sum, sample) => sum + sample.toolCalls, 0);
  const toolResults = result.samples.reduce((sum, sample) => sum + sample.toolResults, 0);
  if (
    !(
      result.completedTurns > 0 &&
      toolCalls > 0 &&
      toolCalls === toolResults &&
      result.teamStress.committedWrites > 0 &&
      result.teamStress.prometheusScrapes > 0
    )
  ) {
    throw new Error(
      "Stress workload lacks completed turns, tools, timestamp writes, or Prometheus scrapes",
    );
  }
  if (options.mode === "allocation" && !(telemetry.sampledAllocatedBytesPerSecond! > 0)) {
    throw new Error("Stress allocation pass did not record allocations");
  }
  if (options.mode === "retention" && !(telemetry.sampledSurvivorBytesPerSecond! > 0)) {
    throw new Error("Stress retention pass did not record sampled survivor bytes");
  }
  const resources = result.memorySamples.findLast((sample) => !sample.collectedGarbage)?.resources;
  const collected = result.memorySamples.findLast((sample) => sample.collectedGarbage)?.resources;
  const workers = resources?.workers;
  const oldGeneration = oldGenerationBytes(collected?.heapSpaces);
  const initialOldGeneration = oldGenerationBytes(telemetry.initialHeapSpaces);
  const endOldGeneration = oldGenerationBytes(telemetry.lastSample.heapSpaces);
  const memory = telemetry.lastSample.memory;
  const durationMinutes = telemetry.durationMs / 60_000;
  const list = rpc["sessions.list"]!;
  const nativeOldGenerationSamples = readdirSync(options.resultDir)
    .filter((file) => /^stress-prometheus-\d+\.prom$/.test(file))
    .map((file) => {
      const text = readFileSync(path.join(options.resultDir, file), "utf8");
      const value =
        /^openclaw_heap_old_generation_after_gc_bytes\{thread="main"\} ([\d.eE+-]+)$/m.exec(
          text,
        )?.[1];
      return {
        scrape: Number(file.match(/\d+/)![0]),
        bytes: value === undefined ? null : Number(value),
      };
    })
    .toSorted((a, b) => a.scrape - b.scrape);
  const nativeOldGeneration = nativeOldGenerationSamples.at(-1)?.bytes;
  return {
    ...options,
    durationMs: telemetry.durationMs,
    rpc,
    gc: telemetry.gc,
    stalls: telemetry.stalls,
    workerHeaps: workers,
    rpcMinutes: result.teamStress.rpcMinutes,
    nativeOldGenerationSamples,
    memoryScope:
      "RSS/main heap at timing stop; workers at last non-forced-GC resource sample; old generation from the last scraped native major-GC epilogue; settled old generation after explicit GC outside timing.",
    metrics: {
      mainThreadCpuPercent: telemetry.mainThreadCpuPercent,
      allocationMiBPerSecond:
        telemetry.sampledAllocatedBytesPerSecond === null
          ? null
          : telemetry.sampledAllocatedBytesPerSecond / MIB,
      sampledSurvivorMiBPerSecond:
        telemetry.sampledSurvivorBytesPerSecond == null
          ? null
          : telemetry.sampledSurvivorBytesPerSecond / MIB,
      initialOldGenerationMiB:
        initialOldGeneration === undefined ? null : initialOldGeneration / MIB,
      oldGenerationGrowthMiB:
        initialOldGeneration === undefined || endOldGeneration === undefined
          ? null
          : (endOldGeneration - initialOldGeneration) / MIB,
      gcSecondsPerMinute:
        Object.values(telemetry.gc).reduce((sum, metric) => sum + metric.totalMs, 0) /
        1000 /
        durationMinutes,
      eventLoopP95Ms: telemetry.eventLoop.p95Ms,
      eventLoopP99Ms: telemetry.eventLoop.p99Ms,
      eventLoopCount: telemetry.eventLoop.count,
      eventLoopMaxMs: telemetry.eventLoop.maxMs,
      sessionsListP50Ms: list.p50Ms,
      sessionsListP99Ms: list.p99Ms,
      sessionsListCount: list.count,
      sessionsListPerMinute: list.count / durationMinutes,
      rpcPerMinute:
        Object.values(rpc).reduce((sum, method) => sum + method.count, 0) / durationMinutes,
      rssMiB: memory.rss / MIB,
      heapMiB: memory.heapUsed / MIB,
      oldGenerationAfterGcMiB: nativeOldGeneration == null ? null : nativeOldGeneration / MIB,
      settledOldGenerationMiB: oldGeneration === undefined ? null : oldGeneration / MIB,
      workerHeapMiB:
        workers?.workerHeapUsedBytes === undefined || workers.workerMemoryMissing.length > 0
          ? null
          : workers.workerHeapUsedBytes / MIB,
      workerHeapCount: workers?.workerHeapSampledCount ?? null,
      workerMemoryMissing: workers?.workerMemoryMissing.length ?? null,
      turns: result.completedTurns,
      toolCalls,
      toolResults,
      committedWrites: result.teamStress.committedWrites,
      prometheusScrapes: result.teamStress.prometheusScrapes,
      stalls: telemetry.stalls.count,
    },
  };
}

/** Mean signed paired deltas; never average percentages from tiny baselines or minute quantiles. */
export function compareStressRuns(runs: StressRun[]) {
  const rows = [];
  const groups = new Map(
    runs.map((run) => [
      `${run.mode}:${Boolean(run.control)}`,
      { mode: run.mode, control: Boolean(run.control) },
    ]),
  );
  for (const { mode, control } of groups.values()) {
    const scoped = runs.filter((run) => run.mode === mode && Boolean(run.control) === control);
    const pairs = [...new Set(scoped.map((run) => run.pair))].map((pair) => ({
      base: scoped.find((run) => run.pair === pair && run.side === "base"),
      candidate: scoped.find((run) => run.pair === pair && run.side === "candidate"),
    }));
    for (const metric of new Set(scoped.flatMap((run) => Object.keys(run.metrics)))) {
      const values = pairs.flatMap(({ base, candidate }) => {
        const a = base?.metrics[metric],
          b = candidate?.metrics[metric];
        return typeof a === "number" &&
          Number.isFinite(a) &&
          typeof b === "number" &&
          Number.isFinite(b)
          ? [{ base: a, candidate: b, delta: b - a }]
          : [];
      });
      const mean = (key: "base" | "candidate" | "delta") =>
        values.length ? values.reduce((sum, value) => sum + value[key], 0) / values.length : null;
      const base = mean("base"),
        candidate = mean("candidate"),
        absolute = mean("delta");
      const tailSamples = metric.startsWith("eventLoop") ? "eventLoopCount" : "sessionsListCount";
      const minimum = metric.includes("P99") ? 1000 : metric.includes("P95") ? 200 : 0;
      const context =
        values.length !== pairs.length || !values.length
          ? "inconclusive: missing paired metric"
          : scoped.some((run) => run.smoke)
            ? "smoke only"
            : mode !== "timing" &&
                metric !== "allocationMiBPerSecond" &&
                metric !== "sampledSurvivorMiBPerSecond"
              ? "diagnostic pass"
              : minimum && scoped.some((run) => (run.metrics[tailSamples] ?? 0) < minimum)
                ? `context: fewer than ${minimum} tail samples`
                : "measured; apply lane acceptance rules";
      rows.push({
        metric,
        mode,
        control,
        base,
        candidate,
        absolute,
        percent: base && absolute !== null ? (absolute / base) * 100 : null,
        pairs: values.length,
        pairedDeltas: values.map((value) => value.delta),
        context,
      });
    }
  }
  return rows;
}
