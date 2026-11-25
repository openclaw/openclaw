/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-prompt-snapshot.ts [arm] [profile]
 * Run this unchanged workload serially in baseline A1/A2 and candidate checkouts,
 * reversing order each round, for five rounds. Setup/imports are outside measurements.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { buildActiveSubagentRuntimeContext } from "../../src/agents/subagents/registry/subagent-active-context.js";
import { subagentRuns } from "../../src/agents/subagents/registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../../src/agents/subagents/registry/subagent-registry-persistence.js";
import {
  createSubagentStoreRunFixture,
  persistRegistryFixture,
} from "../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../src/agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { resolvePhysicalSessionStorePath } from "../../src/config/sessions/session-store-path.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const inspector = new Session();
inspector.connect();
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const controllerSessionKey = "agent:main:main";
  const cfg = {};
  const storePath = resolvePhysicalSessionStorePath(
    { sessionKey: controllerSessionKey, agentId: "main" },
    cfg,
  );
  const now = Date.now();
  const rows = new Map<string, SubagentRunRecord>();
  // 600 direct rows, including 60 suspended results, plus a 100-level requester tree.
  for (let index = 0; index < 700; index++) {
    const requester =
      index <= 600 ? controllerSessionKey : `agent:main:subagent:fixture-${index - 1}`;
    const suspended = index < 600 && index % 10 === 0;
    const entry = createSubagentStoreRunFixture({
      runId: `fixture-${index}`,
      childSessionKey: `agent:main:subagent:fixture-${index}`,
      requesterSessionKey: requester,
      controllerSessionKey: requester,
      requesterAgentId: "main",
      requesterStorePath: storePath,
      controllerStorePath: storePath,
      task: `Synthetic task ${index} ${"t".repeat(4096)}`,
      createdAt: now - 60_000,
      execution: { status: "terminal", startedAt: now - 60_000, endedAt: now - 10_000 },
      completion: { required: true, resultText: `Synthetic result ${index} ${"r".repeat(8192)}` },
      delivery: { status: suspended ? "suspended" : "delivered" },
      cleanupCompletedAt: suspended ? undefined : now - 9_000,
    });
    rows.set(entry.runId, entry);
  }
  persistRegistryFixture(rows);
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const prepare = () => buildActiveSubagentRuntimeContext({ cfg, controllerSessionKey });
  const coldCpu = process.threadCpuUsage();
  const coldStart = performance.now();
  const expected = await prepare();
  const coldWallMs = performance.now() - coldStart;
  const coldUsed = process.threadCpuUsage(coldCpu);
  if (!expected) {
    throw new Error("Expected synthetic subagent context");
  }
  assert(expected.includes("## Child results awaiting delivery"));
  assert(expected.includes("## Recently Completed Subagents"));
  const digest = createHash("sha256").update(expected).digest("hex");
  for (let index = 0; index < 10; index++) {
    assert.equal(await prepare(), expected);
  }
  const iterations = 50;
  global.gc?.();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    assert.equal(await prepare(), expected);
  }
  const wallMs = (performance.now() - start) / iterations;
  const used = process.threadCpuUsage(cpu);
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < 20; index++) {
    assert.equal(await prepare(), expected);
  }
  const { profile: heap } = await inspector.post("HeapProfiler.stopSampling");
  let allocatedBytes = 0;
  const visit = (node: typeof heap.head) => {
    allocatedBytes += node.selfSize;
    node.children.forEach(visit);
  };
  visit(heap.head);
  console.log(
    JSON.stringify({
      arm: process.argv[2],
      rows: rows.size,
      digest,
      wallMs,
      cpuMs: (used.user + used.system) / 1000 / iterations,
      allocatedBytes: allocatedBytes / 20,
      coldWallMs,
      coldCpuMs: (coldUsed.user + coldUsed.system) / 1000,
      load: loadavg(),
    }),
  );
  if (process.argv[3]) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
    for (let index = 0; index < 50; index++) {
      await prepare();
    }
    const { profile } = await inspector.post("Profiler.stop");
    await writeFile(process.argv[3], JSON.stringify(profile));
  }
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
inspector.disconnect();
