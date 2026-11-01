/**
 * Real usage refresh over synthetic obsolete rollups, with foreground writer probes.
 * Run the same script in base/candidate roots, alternating order:
 * node --import ./scripts/tsx.mjs scripts/perf/usage-cache-prune-measure.ts \
 *   --state-dir .local/prune-base --rows 10800 --passes 3 --mode timing
 * Repeat with --mode allocation in separate processes. Seeding and warmup are excluded.
 * Probes arrive every 10 ms independently of completion; they measure writer
 * admission wait, not chat.send ACK or provider latency.
 * Main-isolate sampled allocations include collected objects; CPU includes workers.
 */
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    rows: { type: "string", default: "10800" },
    passes: { type: "string", default: "3" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values["state-dir"], "A new synthetic --state-dir is required");
assert(values.mode === "timing" || values.mode === "allocation");
const rows = Number(values.rows);
const passes = Number(values.passes);
assert(Number.isSafeInteger(rows) && rows > 0);
assert(Number.isSafeInteger(passes) && passes > 0);
const stateDir = path.resolve(values["state-dir"]);
await fs.mkdir(path.dirname(stateDir), { recursive: true });
await fs.mkdir(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;

const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { prepareSessionCostUsageRefreshLock } =
  await import("../../src/infra/session-cost-usage-cache.sqlite.js");
const { refreshCostUsageCacheForAgent } =
  await import("../../src/infra/session-cost-usage-aggregation.js");
const { readSessionCostUsageRollupRowsInDatabase } =
  await import("../../src/infra/session-cost-usage-cache.kernel.js");
const { withOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
const { runOpenClawAgentWorkerWrite } =
  await import("../../src/state/openclaw-agent-write-admission.js");
const config = {};
setRuntimeConfigSnapshot(config);
const agentId = "prune-measure";
const database = openOpenClawAgentDatabase({ agentId });
const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
await fs.mkdir(sessionsDir, { recursive: true });
const inputs = Array.from({ length: rows }, (_, index) => ({
  rollupId: path.join(sessionsDir, `removed-${index}.jsonl`),
  valueJson: new TextEncoder().encode(JSON.stringify({ totalTokens: 10, index })),
  blob: null,
  updatedAt: 1,
  partitions: [{ date: "2026-10-01", valueJson: "{}", blob: new Uint8Array([1]) }],
}));
const diagnostic = channel("openclaw.agent-database.reservation");
const percentile = (samples: number[], fraction: number) =>
  samples.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)] ?? null;
try {
  await refreshCostUsageCacheForAgent({ config, agentId });
  for (let pass = 0; pass < passes; pass++) {
    const owner = prepareSessionCostUsageRefreshLock(agentId);
    try {
      assert(await owner.acquire());
      assert(await owner.writeRollup(inputs));
    } finally {
      await owner.release();
    }
    const holds: number[] = [];
    const queueWaits: number[] = [];
    const observe = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "workerOperations" in message &&
        Array.isArray(message.workerOperations) &&
        message.workerOperations.includes("usageCache.prune") &&
        "writerExecutionMs" in message &&
        typeof message.writerExecutionMs === "number"
      ) {
        holds.push(message.writerExecutionMs);
      }
    };
    diagnostic.subscribe(observe);
    const inspector = new Session();
    try {
      if (values.mode === "allocation") {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      let finished = false;
      const pendingProbes: Promise<void>[] = [];
      const probeErrors: unknown[] = [];
      const probe = async () => {
        for (;;) {
          await delay(10);
          if (finished) {
            break;
          }
          const started = performance.now();
          pendingProbes.push(
            runOpenClawAgentWorkerWrite({ agentId, path: database.path }, async () => {}).then(
              () => {
                queueWaits.push(performance.now() - started);
              },
              (error: unknown) => {
                probeErrors.push(error);
              },
            ),
          );
        }
      };
      const loadBefore = loadavg();
      const cpuBefore = process.cpuUsage();
      const mainCpuBefore = process.threadCpuUsage();
      const started = performance.now();
      const probing = probe();
      try {
        assert.equal(await refreshCostUsageCacheForAgent({ config, agentId }), "refreshed");
      } finally {
        finished = true;
        await probing;
        await Promise.all(pendingProbes);
      }
      if (probeErrors.length) {
        throw new AggregateError(probeErrors, "Foreground writer probe failed");
      }
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuBefore);
      const mainCpu = process.threadCpuUsage(mainCpuBefore);
      let sampledBytes: number | undefined;
      if (values.mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = sumSampledHeapBytes(profile.head);
      }
      const remaining = withOpenClawAgentDatabaseReadOnly(
        ({ db }) => readSessionCostUsageRollupRowsInDatabase(db).length,
        { agentId },
      );
      assert(remaining.found && remaining.value === 0, "Refresh must remove every obsolete row");
      assert(holds.length > 0, "Measurement must observe the real prune writer");
      console.log(
        JSON.stringify({
          pass,
          rows,
          mode: values.mode,
          elapsedMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
          sampledBytes,
          writerRequests: holds.length,
          writerHoldMs: holds,
          foreground: {
            samples: queueWaits.length,
            p50: percentile(queueWaits, 0.5),
            p95: percentile(queueWaits, 0.95),
            max: Math.max(0, ...queueWaits),
          },
          memory: process.memoryUsage(),
          loadBefore,
          loadAfter: loadavg(),
        }),
      );
    } finally {
      diagnostic.unsubscribe(observe);
      inspector.disconnect();
    }
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
}
