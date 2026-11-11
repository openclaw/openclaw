/**
 * Nested-completion liveness owner microbenchmark, not Gateway/provider latency proof.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-active-read-measure.ts
 *   --state-dir .local/active-read --iterations 3000 --retained 10800
 * Repeat with --allocation for separate collected-object sampling. Five counterbalanced
 * pairs compare the previous full-map selector with the public liveness reader over the
 * same real registry/index/claims. Fixture construction and warmup are outside timing.
 * Acceptance: identical liveness before/after claim release; fewer unrelated rows visited;
 * lower CPU/call. Report p50/p95 and sampled bytes/call without extrapolating to turn latency.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "3000" },
    retained: { type: "string", default: "10800" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(global.gc, "Run with --expose-gc");
const integer = (name: "iterations" | "retained") =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback: 1 });
const iterations = integer("iterations");
const retained = integer("retained");
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { mode: 0o700 });
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(root, configPath, { startupTrace: false });
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { getLatestSubagentRunForChild } =
  await import("../../src/agents/subagents/registry/subagent-registry-queries.js");
const { isSubagentSessionRunActive, isSubagentRunLive } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.js");
const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../../src/infra/agent-run-registry.js");
const childSessionKey = "agent:main:subagent:active";
const now = Date.now();
for (let index = 0; index <= retained; index++) {
  const active = index === retained;
  const runId = active ? "active" : `retained-${index}`;
  const entry: SubagentRunRecord = {
    runId,
    childSessionKey: active ? childSessionKey : `agent:main:subagent:${runId}`,
    childAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Synthetic retained subagent",
    cleanup: "keep",
    createdAt: now - 1000,
    generation: 1,
    execution: active
      ? { status: "running", startedAt: now }
      : { status: "terminal", endedAt: now, outcome: { status: "ok" } },
    delivery: { status: "not_required" },
  };
  subagentRuns.set(runId, entry);
}
const token = claimAgentRunContext(
  "active",
  { agentId: "main", sessionKey: childSessionKey },
  { trackOwner: true, ownsContext: true },
);
assert(token);
const readers = {
  // Previous isSubagentSessionRunActive body, using unchanged production selectors.
  base: () => isSubagentRunLive(getLatestSubagentRunForChild(subagentRuns, { childSessionKey })),
  candidate: () => isSubagentSessionRunActive(childSessionKey),
};
const inspector = new Session();
function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
}
try {
  for (const read of Object.values(readers)) {
    for (let index = 0; index < 100; index++) {
      assert.equal(read(), true);
    }
  }
  if (values.allocation) {
    inspector.connect();
  }
  for (let pair = 0; pair < 5; pair++) {
    const order = pair % 2 ? (["candidate", "base"] as const) : (["base", "candidate"] as const);
    for (const arm of order) {
      global.gc();
      await nextTurn();
      const latencies = new Float64Array(iterations);
      const beforeMemory = process.memoryUsage();
      const hostLoad = loadavg();
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const read = readers[arm];
      let live = 0;
      const cpuBefore = process.threadCpuUsage();
      const started = performance.now();
      for (let index = 0; index < iterations; index++) {
        const before = performance.now();
        live += Number(read());
        latencies[index] = performance.now() - before;
      }
      const wallMs = performance.now() - started;
      const cpu = process.threadCpuUsage(cpuBefore);
      const profile = values.allocation
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      assert.equal(live, iterations);
      latencies.sort();
      console.log(
        JSON.stringify({
          arm,
          pair,
          retained,
          iterations,
          mode: values.allocation ? "allocation" : "timing",
          wallMs,
          cpuUsPerCall: (cpu.user + cpu.system) / iterations,
          p50Ms: latencies[Math.ceil(iterations * 0.5) - 1],
          p95Ms: latencies[Math.ceil(iterations * 0.95) - 1],
          allocatedBytesPerCall: profile ? bytes(profile.head) / iterations : undefined,
          beforeMemory,
          afterMemory: process.memoryUsage(),
          hostLoad,
          hostLoadAfter: loadavg(),
        }),
      );
    }
  }
  releaseAgentRunContext("active", token);
  for (const read of Object.values(readers)) {
    assert.equal(read(), false);
  }
} finally {
  releaseAgentRunContext("active", token);
  subagentRuns.clear();
  inspector.disconnect();
}
