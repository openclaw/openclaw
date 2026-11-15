/**
 * Native Code Mode burst-to-serial residency probe, using synthetic catalog/tool data.
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-worker-residency-measure.ts \
 *   <built-root> [owner-source=src/agents/code-mode-node.ts] [seconds=600] [interval-ms=2000] [width=8]
 * Add --smoke for a duration below ten minutes; smoke is setup evidence only.
 * Add --allocations in a separate diagnostic pass for main-isolate sampled allocations.
 * Node 26's native cumulative counter also records untraced main-isolate allocation,
 * including this probe's census work; worker allocations are outside that counter.
 * Add --snapshots <new-directory> for post-window native worker snapshots and heap
 * statistics. Snapshot collection forces GC outside the timed window; files stay local.
 * The alternate owner source replaces the canonical module through a load hook, so
 * its relative imports stay unchanged. The worker comes from the identified build.
 * Eight concurrent cells precede steady serial traffic; every cell crosses three
 * native tool boundaries and verifies fresh globals and its own tool responses.
 * Add --burst-interval-ms 45000 to repeat the burst between serial cells. Both
 * arrival schedules use fixed offsets after the initial burst; executions never
 * overlap between arrivals. Late starts are reported, never silently skipped.
 * Worker starts/hour includes the initial cold burst, normalized by measured time.
 * A final burst runs after timing and optional snapshots to expose restart latency;
 * its eight latency samples are context only and excluded from timed work totals.
 * Default serial p95 has 300 samples; p99 remains context below 1,000 samples.
 * Census samples are unforced heap usage, not retained size. Isolate-seconds use
 * native worker creation/exit events, checked against the Code Mode lifecycle census.
 * Natural post-major-GC old-generation bytes are reported separately when available.
 * GC reclaimed bytes are not allocated bytes; terminated heaps may be uncollected.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { Worker } from "node:worker_threads";
import type { CodeModeExecutor } from "../../src/agents/code-mode-executor-types.js";
import type { GcSample } from "../../src/infra/gc-observer.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    smoke: { type: "boolean" },
    allocations: { type: "boolean" },
    snapshots: { type: "string" },
    "burst-interval-ms": { type: "string" },
  },
});
assert(positionals[0], "A built root is required");
const builtRoot = path.resolve(positionals[0]);
const ownerFile = path.resolve(positionals[1] ?? "src/agents/code-mode-node.ts");
const seconds = Number(positionals[2] ?? 600);
const intervalMs = Number(positionals[3] ?? 2000);
const width = Number(positionals[4] ?? 8);
const burstIntervalMs = values["burst-interval-ms"]
  ? Number(values["burst-interval-ms"])
  : undefined;
assert(Number.isSafeInteger(seconds) && seconds >= (values.smoke ? 1 : 600));
assert(Number.isSafeInteger(intervalMs) && intervalMs > 0);
assert(Number.isSafeInteger(width) && width > 0 && width <= 16);
assert(
  burstIntervalMs === undefined || (Number.isSafeInteger(burstIntervalMs) && burstIntervalMs > 0),
);
const workerFile = path.join(builtRoot, "dist/agents/code-mode-node.worker.js");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const workerHash = digest(workerFile);
const ownerHash = digest(ownerFile);
const ownerUrl = new URL("../../src/agents/code-mode-node.ts", import.meta.url);
const sourceEntrypoints = new URL(
  "../../src/infra/runtime-process-entrypoints.ts",
  import.meta.url,
);
const builtEntrypoints = pathToFileURL(
  path.join(builtRoot, "dist/infra/runtime-process-entrypoints.js"),
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === sourceEntrypoints.href
      ? { ...resolved, url: builtEntrypoints.href }
      : resolved;
  },
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(ownerFile, "utf8")),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { prepareCodeModeNodeCatalog } = await import("../../src/agents/code-mode-node-input.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { getTrackedWorkerLifecycleSnapshot, sampleTrackedWorkerMemory, setTrackedWorkerGcObserver } =
  await import("../../src/infra/worker-cpu.js");
const { LegacyPluginSdkResourceHost } =
  await import("../../src/plugins/legacy-sdk-resource-host.js");
const { createDeferredCore } = await import("../../src/shared/deferred.js");
const { resolveRuntimeProcessEntrypointUrl } =
  await import("../../src/infra/runtime-process-url.js");
assert.equal(
  resolveRuntimeProcessEntrypointUrl("codeModeNode").href,
  pathToFileURL(workerFile).href,
);
const { nodeCodeModeExecutor }: { nodeCodeModeExecutor: CodeModeExecutor } = await import(
  ownerUrl.href
);
const script = "code-mode-node.worker.js";
const config = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 10 * 1024 * 1024,
};
const catalog = prepareCodeModeNodeCatalog({
  catalog: Array.from({ length: 160 }, (_, index) => ({
    name: `tool_${index}`,
    callableName: `tool_${index}`,
    source: "openclaw",
    description: "Synthetic tool description ".repeat(8),
  })),
  namespaces: [],
});
const host = new LegacyPluginSdkResourceHost();
const scheduler = new GatewayScheduler();
host.bindScheduler(scheduler);
const burstLatencies: number[] = [];
const serialLatencies: number[] = [];
const arrivalDelays: number[] = [];
const gc = new Map<
  GcSample["kind"],
  { durationMs: number; reclaimedBytes: number; pauses: number[] }
>();
setTrackedWorkerGcObserver((samples, thread) => {
  if (thread !== script) {
    return;
  }
  for (const sample of samples) {
    let entry = gc.get(sample.kind);
    if (!entry) {
      entry = { durationMs: 0, reclaimedBytes: 0, pauses: [] };
      gc.set(sample.kind, entry);
    }
    entry.durationMs += sample.durationMs;
    entry.reclaimedBytes += sample.reclaimedBytes ?? 0;
    entry.pauses.push(sample.durationMs);
  }
});
const inspector = values.allocations ? new Session() : undefined;
inspector?.connect();
if (inspector) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const loadStart = loadavg();
const allocatedStart = getHeapStatistics().total_allocated_bytes;
assert(Number.isFinite(allocatedStart), "Node with native total_allocated_bytes is required");
const cpuStart = process.cpuUsage();
const threadCpuStart = process.threadCpuUsage();
const startedAt = performance.now();
const nativeWorkers = new Map<Worker, { threadId: number; createdAt: number; exitedAt?: number }>();
const codeModeThreads = new Set<number>();
const codeModeWorkers = () =>
  [...nativeWorkers].filter(([, entry]) => codeModeThreads.has(entry.threadId));
const onWorker = (worker: Worker) => {
  const entry: { threadId: number; createdAt: number; exitedAt?: number } = {
    threadId: worker.threadId,
    createdAt: performance.now(),
  };
  nativeWorkers.set(worker, entry);
  worker.once("exit", () => {
    entry.exitedAt = performance.now();
  });
};
process.on("worker", onWorker);
let activeExecutions = 0;
let bridgeCalls = 0;
const samples: ReturnType<typeof census>[] = [];
function census() {
  const memory = sampleTrackedWorkerMemory({ refresh: false });
  const lifecycle = memory.workerLifecycle.find((entry) => entry.script === script);
  const liveWorkers = lifecycle
    ? lifecycle.started - lifecycle.retired.reduce((sum, entry) => sum + entry.count, 0)
    : 0;
  const heaps = memory.workerHeaps.filter((entry) => entry.script === script);
  const missing = memory.workerMemoryMissing.filter((entry) => entry.script === script);
  for (const entry of [...heaps, ...missing]) {
    if (entry.threadId !== undefined) {
      codeModeThreads.add(entry.threadId);
    }
  }
  const complete = heaps.length === liveWorkers && missing.length === 0;
  return {
    elapsedMs: performance.now() - startedAt,
    liveWorkers,
    activeExecutions,
    complete,
    workerHeapUsedBytes: complete ? heaps.reduce((sum, entry) => sum + entry.heapUsed, 0) : null,
    heaps,
    missing,
    rssBytes: process.memoryUsage().rss,
    hostLoad: loadavg(),
  };
}
const sample = () => {
  samples.push(census());
  sampleTrackedWorkerMemory({ refresh: true });
};
sample();
const sampler = globalThis.setInterval(sample, 1000);
let postWindowKeepAlive: NodeJS.Timeout | undefined;
async function execute(marker: string, ready?: () => Promise<void>) {
  const at = performance.now();
  activeExecutions++;
  let calls = 0;
  try {
    const result = await host.run(() =>
      nodeCodeModeExecutor.execute(
        {
          kind: "exec",
          source: `
        const previous = typeof previousCell;
        globalThis.previousCell = ${JSON.stringify(marker)};
        let reply;
        for (let call = 0; call < 3; call++) reply = await tool_0({ marker: previousCell, call });
        return { previous, marker: previousCell, reply };
      `,
          config,
          ...catalog,
        },
        {
          timeoutMs: config.timeoutMs,
          inlineHost: {
            async onBoundary(boundary, context) {
              calls++;
              bridgeCalls++;
              if (calls === 1) {
                await ready?.();
              }
              assert.equal(boundary.pendingRequests.length, 1);
              const request = boundary.pendingRequests[0]!;
              assert.equal(request.method, "callValue");
              assert.equal(request.args[0], "tool_0");
              assert.deepEqual(request.args[1], { marker, call: calls - 1 });
              return {
                kind: "continue",
                timeoutMs: context.maxTimeoutMs,
                pendingRequests: [],
                settledRequests: [
                  { id: request.id, ok: true, json: JSON.stringify(request.args[1]) },
                ],
              };
            },
          },
        },
      ),
    );
    assert.equal(calls, 3);
    assert(result.status === "completed", JSON.stringify(result));
    assert.equal(
      result.value?.json,
      JSON.stringify({
        previous: "undefined",
        marker,
        reply: { marker, call: 2 },
      }),
    );
    return performance.now() - at;
  } finally {
    activeExecutions--;
  }
}
const percentiles = (measurements: number[]) => {
  const ordered = measurements.toSorted((a, b) => a - b);
  return {
    count: ordered.length,
    medianMs: ordered[Math.floor(ordered.length * 0.5)],
    p95Ms: ordered[Math.floor(ordered.length * 0.95)],
    p99Ms: ordered[Math.floor(ordered.length * 0.99)],
    maxMs: ordered.at(-1),
  };
};
async function runBurst(prefix: string) {
  const barrier = createDeferredCore();
  let admitted = 0;
  return Promise.all(
    Array.from({ length: width }, (_, slot) =>
      execute(`${prefix}-${slot}`, async () => {
        if (++admitted === width) {
          barrier.resolve();
        }
        await barrier.promise;
      }),
    ),
  );
}
try {
  burstLatencies.push(...(await runBurst("initial")));
  sample();
  const serialStartedAt = performance.now();
  const iterations = Math.floor((seconds * 1000) / intervalMs);
  let serial = 0;
  let burst = 1;
  for (;;) {
    const serialOffset = serial < iterations ? serial * intervalMs : Infinity;
    const burstOffset = burstIntervalMs === undefined ? Infinity : burst * burstIntervalMs;
    const offset = Math.min(serialOffset, burstOffset);
    if (offset >= seconds * 1000) {
      break;
    }
    const scheduledAt = serialStartedAt + offset;
    await setTimeout(Math.max(0, scheduledAt - performance.now()));
    arrivalDelays.push(Math.max(0, performance.now() - scheduledAt));
    if (burstOffset <= serialOffset) {
      burstLatencies.push(...(await runBurst(`burst-${burst++}`)));
    } else {
      serialLatencies.push(await execute(`serial-${serial++}`));
    }
  }
  await setTimeout(Math.max(0, serialStartedAt + seconds * 1000 - performance.now()));
  sample();
  clearInterval(sampler);
  const wallMs = performance.now() - startedAt;
  const stoppedAt = startedAt + wallMs;
  const measuredBridgeCalls = bridgeCalls;
  const timedWorkers = codeModeWorkers();
  const cpu = process.cpuUsage(cpuStart);
  const mainCpu = process.threadCpuUsage(threadCpuStart);
  const mainIsolateAllocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedStart;
  const loadEnd = loadavg();
  // Freeze timed GC evidence before profiler materialization, snapshots, and shutdown.
  const measuredGc = [...gc].map(([kind, entry]) =>
    Object.assign(
      { kind, durationMs: entry.durationMs, reclaimedBytes: entry.reclaimedBytes },
      percentiles(entry.pauses),
    ),
  );
  const beforeClose = getTrackedWorkerLifecycleSnapshot();
  const lifecycle = beforeClose.workerLifecycle.find((entry) => entry.script === script);
  assert.equal(
    timedWorkers.length,
    lifecycle?.started,
    "Native events did not account for every Code Mode worker",
  );
  // Warm workers and scheduler jobs are unref'ed; await alone cannot keep snapshots alive.
  postWindowKeepAlive = globalThis.setInterval(() => {}, 1000);
  const allocation = inspector ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  const postWindowHeaps = [];
  if (values.snapshots) {
    mkdirSync(values.snapshots);
    for (const [worker, entry] of timedWorkers) {
      if (entry.exitedAt !== undefined) {
        continue;
      }
      const filename = path.resolve(values.snapshots, `worker-${entry.threadId}.heapsnapshot`);
      await pipeline(
        await worker.getHeapSnapshot(),
        createWriteStream(filename, { flags: "wx", mode: 0o600 }),
      );
      postWindowHeaps.push({
        threadId: entry.threadId,
        snapshot: filename,
        statistics: await worker.getHeapStatistics(),
      });
    }
  }
  const renewedBurst = await runBurst("renewed");
  census();
  const postWindowRenewedBurst = {
    executions: width,
    latency: percentiles(renewedBurst),
    bridgeCalls: bridgeCalls - measuredBridgeCalls,
    workersStarted: codeModeWorkers().length - timedWorkers.length,
  };
  await host.close();
  const afterClose = getTrackedWorkerLifecycleSnapshot();
  let isolateSeconds = 0;
  for (const [, entry] of timedWorkers) {
    isolateSeconds += (Math.min(entry.exitedAt ?? stoppedAt, stoppedAt) - entry.createdAt) / 1000;
  }
  console.log(
    JSON.stringify({
      node: process.version,
      ownerHash,
      workerHash,
      seconds,
      intervalMs,
      burstIntervalMs,
      width,
      smoke: Boolean(values.smoke),
      mode: inspector ? "allocation-diagnostic" : "timing",
      executions: burstLatencies.length + serialLatencies.length,
      workersStartedPerHour: (timedWorkers.length * 3_600_000) / wallMs,
      bridgeCalls: measuredBridgeCalls,
      wallMs,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      mainThreadCpuPercent: (mainCpu.user + mainCpu.system) / (wallMs * 10),
      mainIsolateAllocatedBytes,
      mainIsolateSampledAllocatedBytes: allocation?.profile.samples.reduce(
        (sum, allocationSample) => sum + allocationSample.size,
        0,
      ),
      loadStart,
      loadEnd,
      isolateSeconds,
      postWindowHeaps,
      postWindowRenewedBurst,
      burst: percentiles(burstLatencies),
      serial: percentiles(serialLatencies),
      arrivalDelay: percentiles(arrivalDelays),
      gc: measuredGc,
      lifecycleBeforeClose: beforeClose.workerLifecycle.filter((entry) => entry.script === script),
      lifecycle: afterClose.workerLifecycle.filter((entry) => entry.script === script),
      samples,
    }),
  );
} finally {
  clearInterval(sampler);
  try {
    await host.close();
    await scheduler.stop();
  } finally {
    clearInterval(postWindowKeepAlive);
    setTrackedWorkerGcObserver(undefined);
    process.off("worker", onWorker);
    inspector?.disconnect();
  }
}
