/**
 * Run-state owner proof: 10k rows (6k finished subagents), 40 agents, 64 follow-up turns.
 * Run with: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-run-progress-measure.ts
 * On the base revision, pass --baseline (the prepared reader does not exist there).
 * Reports five untraced CPU samples and separate sampled-allocation passes; no Gateway claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { buildSubagentRunReadIndexFromRuns } from "../../src/agents/subagents/registry/subagent-registry-queries.js";
import { projectGatewaySessionRunState } from "../../src/gateway/session-utils-display.js";
import { buildAgentRunProjectionIndex } from "../../src/infra/agent-run-projection.js";
import { parseAgentSessionKey } from "../../src/routing/session-key.js";

const baseline = process.argv.includes("--baseline");
const preparedReads = await import("../../src/gateway/session-row-prepared-read.js");
const prepared = baseline ? undefined : preparedReads.projectPreparedSessionRunState;
const rows = Array.from({ length: 10_000 }, (_, i) => {
  const key = `agent:worker-${i % 40}:subagent:synthetic-${i}`;
  return {
    key,
    source: {
      parsedKey: parseAgentSessionKey(key),
      entry: {
        sessionId: `session-${i}`,
        updatedAt: 1,
        status: "done" as const,
        spawnedBy: "agent:main:dashboard:synthetic",
        startedAt: 1_000,
        endedAt: 2_000,
      },
    },
  };
});
const runs = new Map(
  rows.slice(0, 6_000).map(({ key }, i) => [
    `run-${i}`,
    {
      runId: `run-${i}`,
      childSessionKey: key,
      requesterSessionKey: "agent:main:dashboard:synthetic",
      createdAt: 1,
      execution: { status: "terminal" as const, startedAt: 1_000, endedAt: 2_000 },
    },
  ]),
);
const subagentRuns = buildSubagentRunReadIndexFromRuns({ runs, inMemoryRuns: [], now: 3_000 });
const contexts = rows.slice(0, 64).map(({ key, source }) => ({
  sessionKey: key,
  sessionId: source.entry.sessionId,
  agentId: source.parsedKey!.agentId,
  projectSessionActive: true,
  lifecycleGeneration: "current",
}));
const index = () => buildAgentRunProjectionIndex({ lifecycleGeneration: "current", contexts });
const rowContext = {
  subagentRuns,
  projectedAgentRuns: index(),
  projectedSubagentActivity: new Set<string>(),
};
function pass(now: number) {
  let checksum = 0;
  for (const { key, source } of rows) {
    const result = prepared
      ? prepared(key, source, now, rowContext)
      : projectGatewaySessionRunState({ key, ...source, now, rowContext });
    checksum +=
      (result.fields.runtimeMs ?? 0) + Number(result.fields.hasActiveSubagentRun === true);
  }
  assert.equal(checksum, 6_000_064);
}
const iterations = 60;
function workload(churn: boolean) {
  for (let i = 0; i < iterations; i++) {
    if (churn && i % 10 === 0) {
      rowContext.projectedAgentRuns = index();
    }
    pass(4_000 + i);
  }
}
for (let i = 0; i < 10; i++) {
  pass(3_000 + i);
}
for (const churn of [false, true]) {
  const cpuSamples = [];
  const allocationSamples = [];
  for (let i = 0; i < 5; i++) {
    global.gc?.();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    workload(churn);
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    cpuSamples.push({ elapsedMs, threadCpuMs: (used.user + used.system) / 1_000 });
    const inspector = new Session();
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    workload(churn);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    allocationSamples.push(profile.samples.reduce((total, sample) => total + sample.size, 0));
  }
  global.gc?.();
  console.log(
    JSON.stringify({
      mode: baseline ? "baseline" : "candidate",
      churn,
      rows: rows.length,
      operations: rows.length * iterations,
      cpuSamples,
      allocationSamples,
      hostLoad: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
