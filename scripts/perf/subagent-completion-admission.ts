/**
 * Resident completion-admission owner on a generated team-shape fixture.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-completion-admission.ts <fixture-dir> <arm> <profile-prefix>
 * Run unchanged on the base and candidate, serially, with A/A controls and interleaved arms.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { buildSubagentRunReadIndexFromRuns } from "../../src/agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const [fixture, arm, profilePrefix] = process.argv.slice(2);
assert(fixture && arm && profilePrefix, "Expected fixture directory, arm and profile prefix");
const summary = safeParseJsonRecord(
  readFileSync(path.join(fixture, "team-shape-summary.json"), "utf8"),
);
assert(summary?.format === "openclaw-team-shape-v1");
const now = Date.now();
const root = "agent:main:subagent:requester";
const runs = new Map<string, SubagentRunRecord>();
// A requester with 336 historical children whose delivery settled before cleanup.
// This owner consumes resident facts; it does not read transcripts or workspace files.
for (let i = 0; i < 336; i++) {
  const run: SubagentRunRecord = {
    runId: `completed-${i}`,
    childSessionKey: `agent:main:subagent:completed-${i}`,
    childAgentId: "main",
    requesterAgentId: "main",
    requesterSessionKey: root,
    requesterDisplayKey: root,
    controllerSessionKey: root,
    task: "Synthetic completed task",
    generation: 2 + i,
    createdAt: now - 10_000,
    execution: { status: "terminal", startedAt: now - 9_000, endedAt: now - 1_000 },
    completion: { required: true },
    delivery: { status: "delivered" },
    cleanup: "keep",
    cleanupHandled: false,
  };
  runs.set(run.runId, run);
}
const index = buildSubagentRunReadIndexFromRuns({ runs, now });
// The benchmark spans the internal option rename; each owner reads its own spelling.
const options = { excludeSuspendedDelivery: true, excludeSettledDelivery: true };
let tick = now;
const classify = () => index.atTime(++tick).countPendingDescendantRuns(root, options);
const blocked = classify();
assert(blocked === 0 || blocked === runs.size);
for (let i = 0; i < 1_000; i++) {
  assert.equal(classify(), blocked);
}
const samples: number[] = [];
global.gc?.();
const cpu = process.cpuUsage();
for (let batch = 0; batch < 50; batch++) {
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    assert.equal(classify(), blocked);
  }
  samples.push((performance.now() - start) / 200);
}
const used = process.cpuUsage(cpu);
const inspector = new Session();
await startCollectedHeapSampling(inspector, 4096);
for (let i = 0; i < 10_000; i++) {
  classify();
}
const { profile: heap } = await inspector.post("HeapProfiler.stopSampling");
let allocatedBytes = 0;
const visit = (node: typeof heap.head) => {
  allocatedBytes += node.selfSize;
  node.children.forEach(visit);
};
visit(heap.head);
await inspector.post("Profiler.enable");
await inspector.post("Profiler.start");
for (let i = 0; i < 10_000; i++) {
  classify();
}
const { profile } = await inspector.post("Profiler.stop");
writeFileSync(`${profilePrefix}.cpuprofile`, JSON.stringify(profile));
writeFileSync(`${profilePrefix}.heapprofile`, JSON.stringify(heap));
inspector.disconnect();
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    arm,
    blocked,
    rows: runs.size,
    samples: samples.length,
    medianMs: samples[25],
    p95Ms: samples[47],
    minMs: samples[0],
    maxMs: samples[49],
    cpuUsPerCall: (used.user + used.system) / 10_000,
    allocatedBytesPerCall: allocatedBytes / 10_000,
    sessionCount: summary.sessionCount,
    agentDatabaseBytes: statSync(path.join(fixture, "agents/main/agent/openclaw-agent.sqlite"))
      .size,
    loadavg: loadavg(),
    node: process.version,
  }),
);
