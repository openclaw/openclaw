/**
 * Measure durable input custody when row publication already retained the entry.
 * node --import ./scripts/tsx.mjs scripts/perf/session-input-custody-measure.ts \
 *   --state-dir .local/custody-base --iterations 2000 --mode timing
 * Run the identical script on base/candidate, alternate order, then repeat with
 * --mode allocation and fresh state directories. Inspector allocation is MAIN
 * thread sampled allocation including collected objects; total CPU includes workers.
 * Each batch creates 32 fresh sessions with 32 KiB skills outside measurement,
 * below the actor replica's residency budget. Measurement includes real stage
 * mutations, native worker custody/settlement and publication, but excludes row
 * creation, initial pending-input reads, actor acquisition and release. This is
 * an owner microbenchmark, not whole-Gateway or provider latency evidence.
 * Memory checkpoints sample tracked direct workers outside the measured windows.
 * Memory checkpoints outside those windows report direct-worker coverage and
 * fresh samples after warmup, before close and after close, without forcing GC.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic state directory");
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const stateDir = path.resolve(values["state-dir"]);
await fs.mkdir(path.dirname(stateDir), { recursive: true });
await fs.mkdir(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;

const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { replaceSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
const { acquireSessionInputActor, withSessionInputActor } =
  await import("../../src/config/sessions/session-input-actor.js");
const { preparePendingInputStore } =
  await import("../../src/config/sessions/session-pending-input-store.js");
const { ensureReplicaSubscription, readSessionActorEntryFacts } =
  await import("../../src/config/sessions/session-actor-replica.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { sampleTrackedWorkerMemory } = await import("../../src/infra/worker-cpu.js");
setRuntimeConfigSnapshot({});
const database = openOpenClawAgentDatabase({ agentId: "main" });
ensureReplicaSubscription();
const inspector = new Session();
const gc: Array<{ startTime: number; duration: number }> = [];
const windows: Array<{ start: number; end: number }> = [];
const latencies: number[] = [];
const observer = new PerformanceObserver((list) => {
  gc.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })));
});
let mainCpuMs = 0;
let totalCpuMs = 0;
let sampledAllocatedBytes = 0;
let reads = 0;
let accepts = 0;
const beforeLoad = loadavg();
const beforeMemory = process.memoryUsage();
async function memoryCheckpoint(phase: "afterWarmup" | "beforeClose" | "afterClose") {
  const requestedAt = performance.now();
  let workers = sampleTrackedWorkerMemory();
  const fresh = () =>
    workers.workerHeapSampledCount === workers.workerCount &&
    workers.workerHeaps.every(
      ({ sampleAgeMs }) =>
        sampleAgeMs !== undefined && sampleAgeMs <= performance.now() - requestedAt + 1,
    );
  // Request once; reading completed replies must not queue more native interrupts.
  if (workers.workerCount > 0) {
    do {
      await delay(10);
      workers = sampleTrackedWorkerMemory({ refresh: false });
    } while (!fresh() && performance.now() - requestedAt < 1000);
  }
  return {
    phase,
    waitMs: performance.now() - requestedAt,
    fresh: fresh(),
    process: process.memoryUsage(),
    workers,
  };
}
const memoryCheckpoints: Awaited<ReturnType<typeof memoryCheckpoint>>[] = [];
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const authority = { assertCurrent() {}, authorize() {} };
async function prepare(index: number) {
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: `agent:main:custody-measure-${index}`,
    sessionId: `custody-measure-${index}`,
  };
  await replaceSessionEntry(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    skillsSnapshot: {
      prompt: "Synthetic skill instructions. ".repeat(1200).slice(0, 32 * 1024),
      skills: [],
    },
  });
  const input = await acquireSessionInputActor(
    {
      ...scope,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    },
    { assertCurrent() {}, assertReadable() {} },
  );
  assert(input);
  const store = await withSessionInputActor(
    { phase: "acceptInput", acquire: async () => input },
    () => preparePendingInputStore(scope, () => {}),
  );
  const identity = {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    idempotencyKey: `custody-input-${index}`,
  };
  const expected = await store.read({ ...identity, kind: "stage", trackCompletion: false });
  assert(expected.kind === "stage" && expected.current && !expected.existing);
  assert(input.actor.target.database.kind === "file");
  assert.equal(input.actor.snapshot(authority), undefined, "fixture must have entry-only facts");
  assert(
    readSessionActorEntryFacts({
      ...input.actor.target,
      database: input.actor.target.database,
    })?.entry,
    "fixture must retain its published entry",
  );
  const read = input.actor.read.bind(input.actor);
  input.actor.read = (...args) => {
    reads += 1;
    return read(...args);
  };
  const accept = input.actor.acceptInput.bind(input.actor);
  input.actor.acceptInput = (...args) => {
    accepts += 1;
    return accept(...args);
  };
  return {
    async run() {
      const receipt = await store.mutate(
        {
          ...identity,
          kind: "stage",
          runId: `custody-run-${index}`,
          requestHash: `custody-hash-${index}`,
          lifecycleGeneration: "synthetic-custody-generation",
          inputId: `custody-input-${index}`,
          messageJson: JSON.stringify({
            role: "user",
            content: "Synthetic custody input",
            timestamp: 1,
          }),
          expected,
          trackCompletion: false,
        },
        () => {},
      );
      assert.equal(receipt.stagedInput?.session_id, scope.sessionId);
      assert.equal(receipt.stagedInput?.input_id, `custody-input-${index}`);
    },
    async release() {
      await store.release();
      await input.actor.release();
    },
  };
}
async function measure() {
  try {
    if (values.mode === "allocation") {
      inspector.connect();
    }
    observer.observe({ entryTypes: ["gc"] });
    // Keep cold module/worker startup out of the measured comparison.
    const warm = await prepare(-1);
    await warm.run();
    await warm.release();
    reads = 0;
    accepts = 0;
    memoryCheckpoints.push(await memoryCheckpoint("afterWarmup"));
    for (let offset = 0; offset < iterations; offset += 32) {
      const batch: Awaited<ReturnType<typeof prepare>>[] = [];
      try {
        for (let index = offset; index < Math.min(offset + 32, iterations); index++) {
          batch.push(await prepare(index));
        }
        await setImmediate();
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const main = process.threadCpuUsage();
        const total = process.cpuUsage();
        const start = performance.now();
        for (const item of batch) {
          const operationStart = performance.now();
          await item.run();
          latencies.push(performance.now() - operationStart);
        }
        windows.push({ start, end: performance.now() });
        const mainUsed = process.threadCpuUsage(main);
        const totalUsed = process.cpuUsage(total);
        mainCpuMs += (mainUsed.user + mainUsed.system) / 1000;
        totalCpuMs += (totalUsed.user + totalUsed.system) / 1000;
        if (values.mode === "allocation") {
          const profile = await inspector.post("HeapProfiler.stopSampling");
          sampledAllocatedBytes += allocated(profile.profile.head);
        }
      } finally {
        for (const item of batch) {
          await item.release();
        }
      }
    }
    await setImmediate();
    const pauses = gc.filter(({ startTime }) =>
      windows.some(({ start, end }) => startTime >= start && startTime < end),
    );
    const sorted = latencies.toSorted((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
    const result = {
      mode: values.mode,
      iterations,
      actorReads: reads,
      actorAccepts: accepts,
      mainCpuMs,
      totalCpuMs,
      elapsedMs: windows.reduce((sum, { start, end }) => sum + end - start, 0),
      sampledMainAllocatedBytes: values.mode === "allocation" ? sampledAllocatedBytes : undefined,
      latencyMs: {
        count: sorted.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1),
      },
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
        maxMs: Math.max(0, ...pauses.map((entry) => entry.duration)),
      },
      hostLoad: { before: beforeLoad, after: loadavg() },
      memory: { before: beforeMemory, after: process.memoryUsage() },
      memoryCheckpoints,
    };
    memoryCheckpoints.push(await memoryCheckpoint("beforeClose"));
    return result;
  } finally {
    observer.disconnect();
    inspector.disconnect();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    memoryCheckpoints.push(await memoryCheckpoint("afterClose"));
  }
}
console.log(JSON.stringify(await measure()));
