/**
 * Warm swarm-summary owner microbenchmark; no Gateway, database, or live state.
 * Native Node can load this owner because its imports are type-only.
 * node scripts/perf/gateway-fresh-array-measure.ts --root <revision> \
 *   --iterations 3000 --mode cpu --label base
 * Repeat with --mode allocation, counterbalancing base/candidate launch order.
 * Compare equal iterations and output hashes; CPU comes from the untraced pass,
 * allocation from a separate sampling pass including already-collected objects.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "cpu" },
    label: { type: "string", default: "candidate" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be positive");
assert(values.mode === "cpu" || values.mode === "allocation", "mode must be cpu or allocation");
const source = path.join(realpathSync(values.root), "src/gateway/session-swarm-summary.ts");
const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
const { buildSessionSwarmSummary }: typeof import("../../src/gateway/session-swarm-summary.js") =
  await import(pathToFileURL(source).href);
const sessionKey = "agent:main:dashboard:synthetic";
const groupCount = 40;
const runsPerGroup = 250;
const runs = Object.freeze(
  Array.from({ length: groupCount * runsPerGroup }, (_, index): SubagentRunReadRecord => {
    const group = Math.floor(index / runsPerGroup);
    const terminal = group < 36;
    return Object.freeze({
      runId: `run-${index}`,
      childSessionKey: `agent:main:subagent:${index}`,
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      swarmRequesterSessionKey: sessionKey,
      collect: true,
      groupId: `group-${group}`,
      createdAt: index,
      execution: Object.freeze({
        status: terminal ? "terminal" : index % 4 === 0 ? "running" : "queued",
      }),
      ...(terminal
        ? { collectorCompletion: Object.freeze({ status: index % 10 === 0 ? "failed" : "done" }) }
        : {}),
    });
  }),
);

function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}

const samplingInterval = 32_768;
for (const includeChildren of [false, true]) {
  const options = { includeChildren };
  const read = () => buildSessionSwarmSummary(runs, sessionKey, "main", options);
  const expected = read();
  assert(expected);
  assert.deepEqual(
    expected.groups.map((group) => group.groupId),
    ["group-39", "group-38", "group-37", "group-36", "group-35"],
  );
  assert.equal(expected.otherActiveGroups, 0);
  for (const group of expected.groups) {
    assert.equal(group.queued + group.running + group.done + group.failed, runsPerGroup);
    assert.equal(group.children?.length, includeChildren ? 64 : undefined);
  }
  const outputSha256 = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  for (let index = 0; index < 100; index++) {
    read();
  }
  const inspector = new Session();
  let allocationBytes: number | undefined;
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  let checksum = 0;
  let last = expected;
  try {
    for (let index = 0; index < iterations; index++) {
      const result = read();
      if (!result) {
        throw new Error("Swarm summary unexpectedly absent");
      }
      last = result;
      checksum += result.groups.length + (result.groups[0]?.children?.length ?? 0);
    }
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    const hostLoadAfter = loadavg();
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocationBytes = sampledBytes(profile.head);
    }
    assert.equal(checksum, iterations * (includeChildren ? 69 : 5));
    assert.equal(createHash("sha256").update(JSON.stringify(last)).digest("hex"), outputSha256);
    console.log(
      JSON.stringify({
        label: values.label,
        mode: values.mode,
        scenario: includeChildren ? "selected-parent" : "roster",
        sourceSha256,
        outputSha256,
        node: process.version,
        runs: runs.length,
        groups: groupCount,
        iterations,
        warmupIterations: 100,
        wallMs,
        mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
        mainThreadCpuUsPerIteration: (cpu.user + cpu.system) / iterations,
        ...(allocationBytes === undefined
          ? {}
          : {
              samplingInterval,
              allocationBytes,
              allocationBytesPerIteration: allocationBytes / iterations,
            }),
        hostLoadBefore,
        hostLoadAfter,
        checksum,
      }),
    );
  } finally {
    inspector.disconnect();
  }
}
