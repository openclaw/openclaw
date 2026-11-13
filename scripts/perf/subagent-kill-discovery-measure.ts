/**
 * node --import ./scripts/tsx.mjs scripts/perf/subagent-kill-discovery-measure.ts
 * [--iterations 3000] [--mode timing|allocation]
 * Counterbalanced AB/BA owner passes: the removed Map adapter versus direct use
 * of the prepared readonly snapshot, both calling the real controller selector.
 * Fixture: 10k retained runs across 40 controllers, 250 rows per prepared scope.
 * Preparation and identity verification are outside measurements. This measures
 * the synchronous discovery consumer, not persistence, draining, or Gateway latency.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { listRunsForControllerFromRuns } from "../../src/agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
assert(values.mode === "timing" || values.mode === "allocation", "invalid mode");
const controllers = Array.from({ length: 40 }, (_, index) => `agent:main:controller-${index}`);
const registry = new Map<string, SubagentRunReadRecord>();
for (let index = 0; index < 10_000; index++) {
  const controllerSessionKey = controllers[index % controllers.length]!;
  const runId = `run-${index}`;
  registry.set(runId, {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    controllerSessionKey,
    requesterSessionKey: controllerSessionKey,
    requesterAgentId: "main",
    createdAt: index,
    execution: { status: "terminal", startedAt: index, endedAt: index + 1 },
  });
}
const snapshots = controllers.map((controller) => ({
  controller,
  runs: new Map([...registry].filter(([, entry]) => entry.controllerSessionKey === controller)),
}));
type Arm = "base" | "candidate";
const select = (arm: Arm, snapshot: (typeof snapshots)[number]) =>
  listRunsForControllerFromRuns(
    arm === "base" ? new Map(snapshot.runs) : snapshot.runs,
    snapshot.controller,
    "main",
  );
for (const snapshot of snapshots) {
  const expected = [...snapshot.runs.values()];
  for (const arm of ["base", "candidate"] as const) {
    const selected = select(arm, snapshot);
    assert.equal(selected.length, 250);
    selected.forEach((entry, index) => assert.equal(entry, expected[index]));
  }
}
const run = (arm: Arm, count: number) => {
  let selected = 0;
  for (let index = 0; index < count; index++) {
    selected += select(arm, snapshots[index % snapshots.length]!).length;
  }
  return selected;
};
run("base", 200);
run("candidate", 200);
for (const [pair, order] of (
  [
    ["base", "candidate"],
    ["candidate", "base"],
  ] as const
).entries()) {
  for (const arm of order) {
    const inspector = new Session();
    const hostLoad = loadavg();
    if (values.mode === "allocation") {
      await startCollectedHeapSampling(inspector, 4096);
    }
    try {
      const cpuStart = process.threadCpuUsage();
      const started = performance.now();
      const selected = run(arm, iterations);
      const wallMs = performance.now() - started;
      const cpu = process.threadCpuUsage(cpuStart);
      const profile =
        values.mode === "allocation"
          ? (await inspector.post("HeapProfiler.stopSampling")).profile
          : undefined;
      assert.equal(selected, iterations * 250);
      console.log(
        JSON.stringify({
          arm,
          pair,
          mode: values.mode,
          iterations,
          registryRows: registry.size,
          scopedRows: 250,
          wallMs,
          mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
          sampledBytesPerIteration: profile
            ? sumSampledHeapBytes(profile.head) / iterations
            : undefined,
          hostLoad,
        }),
      );
    } finally {
      inspector.disconnect();
    }
  }
}
