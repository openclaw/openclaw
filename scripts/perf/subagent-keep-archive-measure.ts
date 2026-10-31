/**
 * Storage-backed kept-run archival and on-demand reads, not Gateway latency proof.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-keep-archive-measure.ts
 *   --state-dir .local/archive-owner-candidate --runs 10000 --iterations 2000
 * Copy this unchanged into the base tooling checkout and add --baseline there.
 * Baseline has no archival operation; it measures the prior retained population.
 * Repeat in AB/BA order, separately with --allocation; sampling perturbs timing.
 * Report archival's one-time cost separately from the identical exact-ID read mix.
 * Ages span 1–100 days: 70% are older than 30 days. Accept lower post-GC residency,
 * exact task/result readback, bounded batches and no retained-history repopulation.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    runs: { type: "string", default: "10000" },
    iterations: { type: "string", default: "2000" },
    baseline: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(global.gc, "Run with --expose-gc");
const integer = (name: "runs" | "iterations") =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback: 1 });
const runCount = integer("runs");
const iterations = integer("iterations");
const stateDir = path.resolve(values["state-dir"]);
mkdirSync(stateDir, { mode: 0o700 });
for (const part of ["home", "tmp", "workspace"]) {
  mkdirSync(path.join(stateDir, part));
}
const configPath = path.join(stateDir, "openclaw.json");
writeFileSync(
  configPath,
  JSON.stringify({
    plugins: { enabled: false },
    agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
  }),
);
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const [database, memory, persistence, reader, codec, kernel] = await Promise.all([
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/agents/subagents/registry/subagent-registry-persistence.js"),
  import("../../src/agents/subagents/registry/subagent-registry-state.js"),
  import("../../src/agents/subagents/registry/subagent-registry.store.codec.js"),
  import("../../src/agents/subagents/registry/subagent-registry.store.kernel.js"),
]);
const archive = values.baseline
  ? undefined
  : await import("../../src/agents/subagents/registry/subagent-registry-archive.js");
const now = Date.now();
const day = 86_400_000;
const runId = (index: number) => `archive-measure-${index}`;
const task = (index: number) => `Synthetic task ${index}: ${"instruction ".repeat(40)}`;
const resultText = (index: number) =>
  `Synthetic result ${index}: ${"result evidence ".repeat(256)}`;
function fixture(index: number): SubagentRunRecord {
  const endedAt = now - (1 + (index % 100)) * day;
  return {
    runId: runId(index),
    childSessionKey: `agent:main:subagent:archive-measure-${index}`,
    childAgentId: "main",
    requesterSessionKey: `agent:main:parent-${index % 100}`,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: task(index),
    cleanup: "keep",
    createdAt: endedAt - 60_000,
    execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
    cleanupCompletedAt: endedAt + 1_000,
    delivery: { status: "delivered" },
    completion: { required: true, resultText: resultText(index), capturedAt: endedAt },
  };
}
async function heap() {
  await nextTurn();
  global.gc!();
  await nextTurn();
  global.gc!();
  return process.memoryUsage();
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
async function measure(label: string, work: () => Promise<void>) {
  if (values.allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const started = performance.now();
  await work();
  const elapsedMs = performance.now() - started;
  const usedCpu = process.threadCpuUsage(cpu);
  const usedProcessCpu = process.cpuUsage(processCpu);
  let allocatedBytes: number | null = null;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = allocated(profile.head);
    writeFileSync(path.join(stateDir, `${label}.heapprofile`), JSON.stringify(profile));
  }
  return {
    elapsedMs,
    mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1_000,
    processCpuMs: (usedProcessCpu.user + usedProcessCpu.system) / 1_000,
    allocatedBytes,
  };
}
try {
  database.openOpenClawStateDatabase();
  if (values.allocation) {
    inspector.connect();
  }
  const empty = await heap();
  for (let offset = 0; offset < runCount; offset += 128) {
    const rows = Array.from({ length: Math.min(128, runCount - offset) }, (_, i) =>
      codec.bindSubagentRunRecord(fixture(offset + i)),
    );
    database.runOpenClawStateWriteTransaction((db) =>
      kernel.writeSubagentRunValuesInDatabase(db, rows, []),
    );
  }
  await persistence.restoreSubagentRunsFromDisk({ runs: memory.subagentRuns });
  const loaded = await heap();
  const hostLoadBefore = loadavg();
  const batchCounts: number[] = [];
  const archival = await measure("archive", async () => {
    if (!archive) {
      return;
    }
    for (;;) {
      const count: number = await archive.archiveCompletedSubagentRuns(now);
      batchCounts.push(count);
      assert(count <= 128, "Archival exceeded its record budget");
      if (count === 0) {
        break;
      }
      await nextTurn();
    }
  });
  const afterArchive = await heap();
  const residentsAfterArchive = memory.subagentRuns.size;
  const expectedArchived = Array.from({ length: runCount }, (_, i) => i).filter(
    (i) => 1 + (i % 100) > 30,
  ).length;
  assert.equal(residentsAfterArchive, runCount - (values.baseline ? 0 : expectedArchived));
  const readOne = async (index: number) => {
    const id = runId(index);
    const prepared = await reader.prepareSubagentRunsSnapshotForRunIds(memory.subagentRuns, [id], {
      exact: true,
    });
    const result = prepared.consume((runs) => {
      const entry = runs.get(id);
      assert(entry, `Read omitted ${id}`);
      assert.equal(entry.task, task(index));
      assert.equal(entry.completion?.resultText, resultText(index));
      return entry.runId;
    });
    assert(result.ready, "Quiescent read unexpectedly required a retry");
    assert.equal(result.value, id);
  };
  await readOne(0);
  const reads = await measure("read", async () => {
    for (let i = 0; i < iterations; i++) {
      await readOne((i * 7919) % runCount);
    }
  });
  const afterReads = await heap();
  assert.equal(
    memory.subagentRuns.size,
    residentsAfterArchive,
    "Historical reads repopulated residents",
  );
  const result = {
    node: process.version,
    baseline: values.baseline,
    sampled: values.allocation,
    runCount,
    iterations,
    now,
    olderThan30Days: expectedArchived,
    residentRuns: {
      loaded: runCount,
      afterArchive: residentsAfterArchive,
      afterReads: memory.subagentRuns.size,
    },
    batchCounts,
    archival,
    reads,
    memory: { empty, loaded, afterArchive, afterReads },
    retainedHeapBytes: {
      loaded: loaded.heapUsed - empty.heapUsed,
      afterArchive: afterArchive.heapUsed - empty.heapUsed,
      afterReads: afterReads.heapUsed - empty.heapUsed,
    },
    hostLoad: { before: hostLoadBefore, after: loadavg() },
  };
  writeFileSync(path.join(stateDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (values.allocation) {
    inspector.disconnect();
  }
  memory.subagentRuns.clear();
  await database.closeOpenClawStateDatabaseAsync();
}
