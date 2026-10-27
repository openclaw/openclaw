/**
 * Settled registry owner retention: synthetic 32 KiB replies, 1k then 2k runs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-run-retention-measure.ts
 * Repeat with `allocation` for a separate inclusive allocation pass. Run unchanged
 * on base/candidate in alternating order. Accept a lower retained-heap slope with
 * identical selected run IDs and no consistent CPU/allocation regression. Setup
 * and forced GC are outside timing; this is owner evidence, not Gateway latency.
 * Add `--batch-runs=4653` to retain 4,653 then 9,306 rows at the same boundaries.
 * `timing --assert-retention` checks settled 32 KiB replies stay below 8 KiB/run.
 * `preview-timing --assert-retention` checks retained terminal previews alone stay
 * below 10 KiB/run, without compaction masking full-reply backing-string retention.
 * `lookup-timing` / `lookup-allocation` isolate two 10k/20k run lookup views with
 * 2k requesters, matching the live/committed lookup population without payloads.
 * Add `--assert-retention` to lookup-timing for the regression budget: the second
 * 10k rows must retain less than 3,300 bytes/run (base retained ~3,667 bytes/run).
 * `topology-timing` / `topology-allocation` build the complete read topology with
 * the same rows present in live and committed views; old builds are released.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { prepareAgentRunTerminalReply } from "../../src/agents/agent-run-terminal-reply.js";
import {
  compactSubagentRunForMemory,
  getSubagentSessionReadLookup,
  subagentRuns,
} from "../../src/agents/subagents/registry/subagent-registry-memory.js";
import { buildSubagentRunReadTopology } from "../../src/agents/subagents/registry/subagent-registry-read-topology.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { SubagentSessionReadLookup } from "../../src/agents/subagents/registry/subagent-session-read-scope.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

assert(global.gc, "Run with --expose-gc");
const mode = process.argv[2] ?? "timing";
assert(
  [
    "timing",
    "allocation",
    "preview-timing",
    "preview-allocation",
    "lookup-timing",
    "lookup-allocation",
    "topology-timing",
    "topology-allocation",
  ].includes(mode),
);
const previewOnly = mode.startsWith("preview-");
const previews: Array<ReturnType<typeof prepareAgentRunTerminalReply>["terminalReply"]> = [];
const lookupOnly = mode.startsWith("lookup-");
const topologyOnly = mode.startsWith("topology-");
const allocation = mode.endsWith("allocation");
const count = parseStrictIntegerOption({
  raw: process.argv.find((arg) => arg.startsWith("--batch-runs="))?.slice("--batch-runs=".length),
  label: "--batch-runs",
  fallback: lookupOnly || topologyOnly ? 10_000 : 1_000,
  min: 1,
});
let persisted = new SubagentSessionReadLookup();
const topologyRuns = new Map<string, SubagentRunRecord>();
let topology: ReturnType<typeof buildSubagentRunReadTopology<SubagentRunRecord>> | undefined;
function createRun(index: number): SubagentRunRecord {
  const text =
    lookupOnly || topologyOnly
      ? "short reply"
      : Buffer.from(`Synthetic reply ${index}. `.repeat(2_000).slice(0, 32_768)).toString();
  return {
    runId: `run-${index}`,
    childSessionKey: `agent:main:subagent:${index}`,
    childAgentId: "main",
    requesterSessionKey:
      lookupOnly || topologyOnly ? `agent:main:parent:${index % 2_000}` : "agent:main:main",
    requesterDisplayKey: "main",
    task: `Synthetic task ${index}`,
    cleanup: "keep",
    createdAt: index + 1,
    execution: { status: "terminal", endedAt: index + 2, outcome: { status: "ok" } },
    cleanupCompletedAt: index + 3,
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    completion: {
      required: true,
      resultText: text,
      terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
      capturedAt: index + 2,
    },
  };
}
function append(start: number, end: number) {
  for (let i = start; i < end; i++) {
    const run = createRun(i);
    if (previewOnly) {
      previews.push(run.completion!.terminalReply!);
      continue;
    }
    const row = compactSubagentRunForMemory(run);
    if (topologyOnly) {
      topologyRuns.set(row.runId, row);
      continue;
    }
    subagentRuns.set(row.runId, row);
    if (lookupOnly) {
      persisted.set(row.runId, row);
    }
  }
  if (previewOnly) {
    assert.equal(previews.length, end);
    return;
  }
  if (topologyOnly) {
    topology = buildSubagentRunReadTopology({
      runs: new Map(topologyRuns),
      inMemoryRuns: topologyRuns.values(),
    });
    assert.equal(topology.runsByChildSessionKey.size, end);
    return;
  }
  const lookup = getSubagentSessionReadLookup(subagentRuns);
  if (lookupOnly) {
    for (let i = 0; i < 2_000; i++) {
      const parent = `agent:main:parent:${i}`;
      assert.equal(
        persisted.selectSessions([parent], lookup).cacheKeys.length,
        Math.ceil((end - i) / 2_000),
      );
      assert.equal(
        lookup.selectControllers(new Set([parent])).length,
        Math.ceil((end - i) / 2_000),
      );
    }
  } else {
    assert.equal(lookup.selectSessions(["agent:main:main"], lookup).cacheKeys.length, end);
  }
}
async function heap() {
  await nextTurn();
  global.gc!();
  await nextTurn();
  global.gc!();
  return process.memoryUsage().heapUsed;
}
append(0, lookupOnly || topologyOnly ? 2_000 : 100);
subagentRuns.clear();
persisted = new SubagentSessionReadLookup();
topologyRuns.clear();
topology = undefined;
previews.length = 0;
const baselineHeap = await heap();
const inspector = new Session();
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const load = loadavg();
const points = [];
for (let batch = 0; batch < 2; batch++) {
  const before = process.threadCpuUsage();
  const started = performance.now();
  append(batch * count, (batch + 1) * count);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(before);
  points.push({
    runs: previewOnly ? previews.length : topologyOnly ? topologyRuns.size : subagentRuns.size,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    elapsedMs,
    retainedBytes: (await heap()) - baselineHeap,
  });
}
let allocatedBytes: number | undefined;
if (allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(JSON.stringify({ mode, iterations: count * 2, load, points, allocatedBytes }));
subagentRuns.clear();
if (process.argv.includes("--assert-retention")) {
  assert(
    ["timing", "lookup-timing", "preview-timing"].includes(mode),
    "Retention budget requires an untraced payload or lookup pass",
  );
  const bytesPerRun = (points[1]!.retainedBytes - points[0]!.retainedBytes) / count;
  const budget = lookupOnly ? 3_300 : previewOnly ? 10_240 : 8_192;
  assert(bytesPerRun < budget, `Retention ${bytesPerRun} bytes/run exceeds ${budget}`);
}
