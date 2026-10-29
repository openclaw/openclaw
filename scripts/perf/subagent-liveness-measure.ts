/**
 * Subagent liveness per prepared broadcast/page: 10k rows, 100 live executors.
 * OPENCLAW_STATE_DIR=<isolated-dir> node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/subagent-liveness-measure.ts timing
 * Repeat with allocation for collected-object sampling. Run unchanged on base and
 * candidate in alternating order; setup/index construction stay outside measurement.
 * A broadcast reads all 10k rows; a 200-row page includes all 100 active children.
 * Each row evaluates liveness once, as projectGatewaySessionRunState does. This
 * isolates the owner cost, not RPC latency, transport fanout, or full presentation.
 * Accept fewer allocated bytes with identical answers and no consistent CPU rise.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { subagentRuns } from "../../src/agents/subagents/registry/subagent-registry-memory.js";
import { buildSubagentSessionListReadIndex } from "../../src/agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { isSubagentRunLive } from "../../src/agents/subagents/registry/subagent-run-liveness.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunContext,
} from "../../src/infra/agent-run-registry.js";

assert(global.gc, "Run with --expose-gc");
assert(process.env.OPENCLAW_STATE_DIR, "Use an isolated OPENCLAW_STATE_DIR");
const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const now = Date.UTC(2026, 9, 26);
const claims = new Map<string, string>();
for (let i = 0; i < 10_000; i++) {
  const running = i < 100;
  const row: SubagentRunRecord = {
    runId: `synthetic-${i}`,
    childSessionKey: `agent:main:subagent:synthetic-${i}`,
    childAgentId: "main",
    requesterSessionKey: `agent:main:parent-${Math.floor(i / 5)}`,
    requesterAgentId: "main",
    requesterStorePath: "/synthetic/agents/main/sessions",
    requesterDisplayKey: "main",
    task: "Synthetic liveness measurement",
    cleanup: "keep",
    generation: 1,
    createdAt: now - 60_000,
    execution: running
      ? { status: "running", startedAt: now - 60_000 }
      : { status: "terminal", endedAt: now - 1_000 },
  };
  subagentRuns.set(row.runId, row);
  if (running) {
    const claim = claimAgentRunContext(
      row.runId,
      { agentId: "main", sessionKey: row.childSessionKey },
      { trackOwner: true, ownsContext: true },
    );
    assert(claim);
    claims.set(row.runId, claim);
  }
}
const index = buildSubagentSessionListReadIndex(now, undefined, subagentRuns);
const rows = Array.from(subagentRuns.values(), (row) =>
  index.getDisplaySubagentRun(row.childSessionKey),
);
const iterations = 2_000;
const inspector = new Session();
const sumBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sumBytes(child), 0);
try {
  for (const size of [200, 10_000]) {
    const read = () => {
      let live = 0;
      for (let row = 0; row < size; row++) {
        live += Number(isSubagentRunLive(rows[row]));
      }
      return live;
    };
    for (let warmup = 0; warmup < 100; warmup++) {
      assert.equal(read(), 100);
    }
    global.gc();
    if (mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const before = process.threadCpuUsage();
    const start = performance.now();
    let checksum = 0;
    for (let iteration = 0; iteration < iterations; iteration++) {
      checksum += read();
    }
    const elapsedMs = performance.now() - start;
    const cpu = process.threadCpuUsage(before);
    assert.equal(checksum, iterations * 100);
    const profile =
      mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    inspector.disconnect();
    console.log(
      JSON.stringify({
        mode,
        workload: size === 200 ? "page" : "broadcast",
        iterations,
        evaluationsPerIteration: size,
        livePerIteration: 100,
        elapsedMs,
        cpuUsPerIteration: (cpu.user + cpu.system) / iterations,
        allocatedBytesPerIteration: profile ? sumBytes(profile.head) / iterations : undefined,
        hostLoad,
        hostLoadAfter: loadavg(),
        checksum,
      }),
    );
  }
} finally {
  inspector.disconnect();
  for (const [runId, claim] of claims) {
    releaseAgentRunContext(runId, claim);
    clearAgentRunContext(runId);
  }
  subagentRuns.clear();
}
