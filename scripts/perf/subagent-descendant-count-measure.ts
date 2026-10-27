/**
 * Descendant-count owner probe: 10k retained runs, 2k requesters, 5% unended groups.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-descendant-count-measure.ts timing
 * Repeat with allocation for collected-object sampling; fixture/warmup are excluded.
 * Each run makes 3,000 fresh query windows, 6 million count calls. Compare frozen
 * base/candidate in alternating order. Accept lower sampled bytes/query and no
 * consistent CPU regression; this is owner evidence, not whole-Gateway latency.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { buildSubagentRunReadIndexFromRuns } from "../../src/agents/subagents/registry/subagent-registry-queries.ts";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.ts";
const now = Date.UTC(2026, 9, 26);
const roots = Array.from({ length: 2000 }, (_, i) => `agent:main:parent-${i}`);
const runs = new Map<string, SubagentRunReadRecord>();
for (let i = 0; i < 10000; i++) {
  const root = Math.floor(i / 5);
  const active = root % 20 === 0 && i % 5 === 0;
  const runId = `synthetic-${i}`;
  runs.set(runId, {
    runId,
    childSessionKey: `agent:main:subagent:${i}`,
    requesterSessionKey: roots[root]!,
    createdAt: now - 1000,
    generation: 1,
    execution: active
      ? { status: "running", startedAt: now - 1000 }
      : { status: "terminal", endedAt: now - 500 },
    cleanupCompletedAt: active ? undefined : now,
    delivery: { status: "not_required" },
  });
}
const index = buildSubagentRunReadIndexFromRuns({ runs, now });
function pass() {
  const view = index.atTime(now);
  let sum = 0;
  for (const root of roots) {
    sum += view.countActiveDescendantRuns(root);
  }
  return sum;
}
for (let i = 0; i < 100; i++) {
  assert.equal(pass(), 100);
}
const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation", "Expected timing or allocation");
const iterations = 3000;
const inspector = new Session();
assert(global.gc);
global.gc();
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const load = loadavg();
const cpuBefore = process.threadCpuUsage();
const started = performance.now();
let checksum = 0;
for (let i = 0; i < iterations; i++) {
  checksum += pass();
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuBefore);
assert.equal(checksum, 100 * iterations);
let allocatedBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sumBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, n) => sum + sumBytes(n), 0);
  allocatedBytes = sumBytes(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode,
    iterations,
    queries: iterations * roots.length,
    runs: runs.size,
    active: 100,
    elapsedMs,
    cpuUsPerQuery: (cpu.user + cpu.system) / iterations / roots.length,
    allocatedBytes,
    allocatedBytesPerQuery:
      allocatedBytes === undefined ? undefined : allocatedBytes / iterations / roots.length,
    load,
    loadAfter: loadavg(),
    checksum,
  }),
);
