/**
 * Pending-input owner contention benchmark (not a Gateway/WebSocket load test).
 * node --import ./scripts/tsx.mjs scripts/perf/chat-send-persist-measure.ts \
 *   --state-dir .local/persist-base --iterations 2000 --sessions 10000 --mode timing
 * Repeat unchanged on both revisions in AB/BA order, then --mode allocation.
 * Real actors, pending custody, sharing readers and commit receipts; synthetic
 * authority validates identity only, so policy/revocation proof belongs to tests.
 * Four unrelated metadata/append writers compete per staged input. CPU/allocation
 * cover the fixed foreground+background workload including input settlement;
 * latency and phase samples cover stage only. No cron/audit scheduler is started.
 * Outside measurement, live and cleaned-up owners each quiesce for three seconds;
 * checkpoints force main-isolate GC and report fresh direct-worker sample coverage.
 * Worker heaps are sampled, not forcibly collected; raw endpoints remain intact.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionPendingInputAuthorityFacts } from "../../src/config/sessions/session-pending-input-authority.js";
import type { SessionMutationAuthorization } from "../../src/gateway/server-methods/types.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    sessions: { type: "string", default: "10000" },
    mode: { type: "string", default: "timing" },
    writers: { type: "string", default: "4" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = Number(values.iterations),
  sessions = Number(values.sessions),
  writers = Number(values.writers);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(sessions) && sessions >= 32);
assert(Number.isSafeInteger(writers) && writers >= 0 && writers < 16);
const stateDir = path.resolve(values["state-dir"]);
await mkdir(path.dirname(stateDir), { recursive: true });
await mkdir(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
} = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { replaceSessionEntryInDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
const { replaceSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
const { appendTranscriptMessage } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.js");
const { stageSessionPendingInput } =
  await import("../../src/config/sessions/session-accessor.pending-inputs.js");
const { acquireSessionInputActor, withSessionInputActor } =
  await import("../../src/config/sessions/session-input-actor.js");
const { createSessionSharingInputAuthority } =
  await import("../../src/gateway/session-sharing-read.js");
const { withSessionSharingTarget } = await import("../../src/gateway/session-sharing-policy.js");
const { withDiagnosticsTimelineObserver } = await import("../../src/infra/diagnostics-timeline.js");
const { getTrackedWorkerPoolSnapshot, sampleTrackedWorkerMemory } =
  await import("../../src/infra/worker-cpu.js");
const cfg = {
  logging: {
    level: "silent" as const,
    consoleLevel: "silent" as const,
    file: path.join(stateDir, "run.log"),
  },
};
setRuntimeConfigSnapshot(cfg);
const database = openOpenClawAgentDatabase({ agentId: "main" });
const scope = (index: number) => ({
  agentId: "main",
  storePath: database.path,
  sessionKey: `agent:main:persist-${index}`,
  sessionId: `persist-${index}`,
});
// Bootstrap before any actors/readers exist; each row still uses the native entry owner.
runOpenClawAgentWriteTransaction(
  (db) => {
    for (let index = 0; index < sessions; index++) {
      replaceSessionEntryInDatabase(db, scope(index).sessionKey, {
        sessionId: scope(index).sessionId,
        updatedAt: 1,
        status: index < 32 ? undefined : "done",
        skillsSnapshot: { prompt: "Synthetic retained instructions. ".repeat(32), skills: [] },
      });
    }
  },
  { agentId: "main", path: database.path },
);
const actors: NonNullable<Awaited<ReturnType<typeof acquireSessionInputActor>>>[] = [];
const phases = new Map<string, number[]>();
const latencies: number[] = [];
let authorityReads = 0,
  preparedChecks = 0,
  backgroundWrites = 0;
const inspector = new Session();
let inspectorConnected = false;
async function memoryCheckpoint(phase: "live" | "afterCleanup") {
  await delay(3000);
  const beforeGc = process.memoryUsage();
  if (!inspectorConnected) {
    inspector.connect();
    inspectorConnected = true;
  }
  await inspector.post("HeapProfiler.collectGarbage");
  await setImmediate();
  const afterMainGc = process.memoryUsage();
  const requestedAt = performance.now();
  let workers = sampleTrackedWorkerMemory();
  const fresh = () =>
    workers.workerHeapSampledCount === workers.workerCount &&
    workers.workerHeaps.every(
      ({ sampleAgeMs }) =>
        sampleAgeMs !== undefined && sampleAgeMs <= performance.now() - requestedAt + 1,
    );
  if (workers.workerCount > 0) {
    do {
      await delay(10);
      workers = sampleTrackedWorkerMemory({ refresh: false });
    } while (!fresh() && performance.now() - requestedAt < 1000);
  }
  return {
    phase,
    quiescenceMs: 3000,
    beforeGc,
    afterMainGc,
    workerSampleWaitMs: performance.now() - requestedAt,
    fresh: fresh(),
    workers,
    pools: getTrackedWorkerPoolSnapshot(),
  };
}
const memoryCheckpoints: Awaited<ReturnType<typeof memoryCheckpoint>>[] = [];
const pauses: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    // The observer subscribes only to Node's GC entries.
    const { kind } = (entry as typeof entry & { detail: { kind: number } }).detail;
    pauses.push({ kind, duration: entry.duration });
  }
});
function quantiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const p = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
  return {
    count: sorted.length,
    p50: p(0.5),
    p90: p(0.9),
    p95: p(0.95),
    p99: p(0.99),
    max: sorted.at(-1) ?? 0,
  };
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
async function measure() {
  try {
    for (let index = 0; index < 16; index++) {
      const target = scope(index);
      const actor = await acquireSessionInputActor(
        { ...target, target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] } },
        { assertCurrent() {}, assertReadable() {} },
      );
      assert(actor);
      actors.push(actor);
    }
    const authorities = actors.map((_actor, index) => {
      const target = scope(index);
      let current: Parameters<Parameters<typeof withSessionSharingTarget>[1]>[0] | undefined;
      let selection: Parameters<typeof withSessionSharingTarget>[2];
      const check = (facts: SessionPendingInputAuthorityFacts) => {
        assert.equal(facts.sessionKey, target.sessionKey);
        assert.equal(facts.entry?.sessionId, target.sessionId);
      };
      const authorization: SessionMutationAuthorization = {
        assertCurrent() {
          assert(current);
          current.assertCurrent();
          assert.equal(current.target?.entry.sessionId, target.sessionId);
        },
        withCurrent: (consume) => {
          authorityReads++;
          return withSessionSharingTarget(
            { cfg, ...target },
            (read) => {
              selection ??= read.selection;
              current = read;
              try {
                authorization.assertCurrent();
                return consume();
              } finally {
                current = undefined;
              }
            },
            selection,
          );
        },
        withPreparedCurrent(facts, consume, assertSourceCurrent) {
          preparedChecks++;
          assertSourceCurrent();
          check(facts);
          return consume();
        },
      };
      const authority = createSessionSharingInputAuthority({ client: null }, authorization, () => {
        assert(current);
        return current;
      });
      assert(authority);
      return authority;
    });
    async function run(index: number, measured: boolean) {
      const slot = ((index % 16) + 16) % 16,
        target = scope(slot),
        runId = `persist-run-${index}`;
      const background = Array.from({ length: writers }, async (_, lane) => {
        const other = scope(16 + lane);
        if (lane % 2) {
          await appendTranscriptMessage(other, {
            message: {
              role: "assistant",
              content: "Synthetic background append",
              timestamp: index + 100,
            },
          });
        } else {
          await replaceSessionEntry(other, {
            sessionId: other.sessionId,
            updatedAt: index + 100,
            label: `Synthetic update ${index}`,
          });
        }
        if (measured) {
          backgroundWrites++;
        }
      });
      const start = performance.now();
      const stage = () =>
        withSessionInputActor({ phase: "acceptInput", acquire: async () => actors[slot] }, () =>
          stageSessionPendingInput(target, {
            runId,
            message: {
              role: "user",
              content: "Synthetic input",
              timestamp: index + 100,
              idempotencyKey: `${runId}:user`,
            },
            authority: authorities[slot],
            assertCurrent() {},
            prepareMessageAfterIdempotencyCheck: (message) => message,
          }),
        );
      const staging = (
        measured
          ? withDiagnosticsTimelineObserver((name, _attributes, durationMs) => {
              const begin = performance.now();
              return () => {
                const samples = phases.get(name) ?? [];
                samples.push(durationMs ?? performance.now() - begin);
                phases.set(name, samples);
              };
            }, stage)
          : stage()
      ).then((receipt) => {
        assert(receipt?.state === "queued");
        if (measured) {
          latencies.push(performance.now() - start);
        }
        return receipt;
      });
      const [receipt] = await Promise.all([staging, ...background]);
      receipt.finish("interrupted");
      await receipt.settled?.();
    }
    for (let index = -16; index < 0; index++) {
      await run(index, false);
    }
    authorityReads = 0;
    preparedChecks = 0;
    await setImmediate();
    observer.observe({ entryTypes: ["gc"] });
    if (values.mode === "allocation") {
      inspector.connect();
      inspectorConnected = true;
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const before = { load: loadavg(), memory: process.memoryUsage() };
    const main = process.threadCpuUsage(),
      total = process.cpuUsage(),
      start = performance.now();
    for (let index = 0; index < iterations; index++) {
      await run(index, true);
    }
    const elapsedMs = performance.now() - start,
      mainUsed = process.threadCpuUsage(main),
      totalUsed = process.cpuUsage(total);
    const sampledBytes =
      values.mode === "allocation"
        ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
    await setImmediate();
    observer.disconnect();
    const after = { load: loadavg(), memory: process.memoryUsage() };
    memoryCheckpoints.push(await memoryCheckpoint("live"));
    return {
      mode: values.mode,
      iterations,
      sessions,
      writers,
      elapsedMs,
      authorityReads,
      preparedChecks,
      backgroundWrites,
      mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
      totalCpuMs: (totalUsed.user + totalUsed.system) / 1000,
      sampledAllocatedBytes: sampledBytes,
      stageMs: quantiles(latencies),
      phases: Object.fromEntries([...phases].map(([name, samples]) => [name, quantiles(samples)])),
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, value) => sum + value.duration, 0),
        maxMs: Math.max(0, ...pauses.map((value) => value.duration)),
        byKind: Object.fromEntries(
          [...new Set(pauses.map((value) => value.kind))].map((kind) => {
            const durations = pauses.filter((value) => value.kind === kind).map((v) => v.duration);
            return [
              kind,
              { ...quantiles(durations), totalMs: durations.reduce((a, b) => a + b, 0) },
            ];
          }),
        ),
      },
      before,
      after,
      memoryCheckpoints,
    };
  } finally {
    observer.disconnect();
    for (const actor of actors.splice(0)) {
      await actor.actor.release();
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
  }
}
try {
  const result = await measure();
  memoryCheckpoints.push(await memoryCheckpoint("afterCleanup"));
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
}
