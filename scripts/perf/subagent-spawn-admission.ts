/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-spawn-admission.ts
 * Synthetic 20,000 durable rows plus 4,800 live rows (3,200 overlapping), 20 direct children.
 * Five serial A/A pairs followed by five serial A/B pairs. No production state or workspace IO.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import {
  admissionFixture,
  countAdmissionBefore,
} from "../../src/agents/subagents/registry/subagent-admission.test-support.js";
import { subagentRuns } from "../../src/agents/subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  countActiveSubagentRunsForSession,
  getSubagentSessionListReadSnapshotIdentity,
  clearSubagentRunsReadCacheForTest,
} from "../../src/agents/subagents/registry/subagent-registry-state.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
const inspector = new Session();
inspector.connect();
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const { persisted, live } = admissionFixture();
  persistRegistryFixture(persisted);
  for (const [id, entry] of live) {
    subagentRuns.set(id, entry);
  }
  const snapshot = getSubagentSessionListReadSnapshotIdentity();
  assert(snapshot instanceof Map);
  const run = {
    A: () => countAdmissionBefore(snapshot, subagentRuns, "owner-0"),
    B: () => countActiveSubagentRunsForSession(subagentRuns, "owner-0"),
  };
  const coldAStart = performance.now();
  const coldACpu = process.cpuUsage();
  const expected = run.A();
  const coldAUsed = process.cpuUsage(coldACpu);
  const coldAWall = performance.now() - coldAStart;
  const coldStart = performance.now();
  const coldBCpu = process.cpuUsage();
  assert.equal(run.B(), expected);
  const coldBUsed = process.cpuUsage(coldBCpu);
  console.log(
    JSON.stringify({
      kind: "fixture",
      durable: persisted.size,
      live: live.size,
      count: expected,
      firstBaselineReadMs: coldAWall,
      firstBaselineCpuMs: (coldAUsed.user + coldAUsed.system) / 1000,
      firstIndexedReadMs: performance.now() - coldStart,
      firstIndexedCpuMs: (coldBUsed.user + coldBUsed.system) / 1000,
      load: loadavg(),
    }),
  );
  for (let warmup = 0; warmup < 10; warmup++) {
    assert.equal(run.A(), expected);
    assert.equal(run.B(), expected);
  }
  async function measure(arm: "A" | "B", phase: string, pair: number) {
    global.gc?.();
    const iterations = 100;
    const start = performance.now();
    const cpu = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
      assert.equal(run[arm](), expected);
    }
    const used = process.cpuUsage(cpu);
    const wallMs = (performance.now() - start) / iterations;
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < 20; index++) {
      assert.equal(run[arm](), expected);
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    console.log(
      JSON.stringify({
        phase,
        pair,
        arm,
        wallMs,
        cpuMs: (used.user + used.system) / 1000 / iterations,
        allocatedBytes: bytes(profile.head) / 20,
        load: loadavg(),
      }),
    );
  }
  for (const phase of ["AA", "AB"]) {
    for (let pair = 0; pair < 5; pair++) {
      await measure("A", phase, pair);
      await measure(phase === "AA" ? "A" : "B", phase, pair);
    }
  }
  if (process.argv[2]) {
    await inspector.post("Profiler.enable");
    for (const arm of ["A", "B"] as const) {
      await inspector.post("Profiler.start");
      for (let index = 0; index < (arm === "A" ? 100 : 100_000); index++) {
        run[arm]();
      }
      const { profile } = await inspector.post("Profiler.stop");
      await writeFile(`${process.argv[2]}-${arm}.cpuprofile`, JSON.stringify(profile));
    }
  }
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
inspector.disconnect();
