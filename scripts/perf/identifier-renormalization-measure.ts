/**
 * Owner microbench: 10k session keys, 200 skills, and 64 retained media operations.
 * Run separately on each revision, alternating base/candidate order:
 * node --import ./scripts/tsx.mjs scripts/perf/identifier-renormalization-measure.ts
 * --module-root <directory> selects the three owner modules under its src/ tree.
 * Source snapshots must preserve their original dependency resolution.
 * Add --allocations for a separate sampled-allocation pass; ignore its timings.
 * Each workload runs five batches of 2,000 calls after warmup. Acceptance: equal
 * results, less CPU/allocation for repeated normalization, and no material loss
 * on the explicit-media-owner control. This makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createCanonicalFixtureSkill } from "../../src/skills/test-support/test-helpers.js";

const { values } = parseArgs({
  options: {
    "module-root": { type: "string", default: process.cwd() },
    allocations: { type: "boolean", default: false },
  },
});
const moduleUrl = (name: string) => pathToFileURL(resolve(values["module-root"], name)).href;
const { canonicalizeSessionKeyForAgent }: typeof import("../../src/gateway/session-store-key.js") =
  await import(moduleUrl("src/gateway/session-store-key.ts"));
const {
  createMediaGenerationOperation,
  listMediaGenerationOperations,
}: typeof import("../../src/agents/media-generation-activity.js") = await import(
  moduleUrl("src/agents/media-generation-activity.ts")
);
const {
  findSkillUsageMatch,
}: typeof import("../../src/agents/agent-tools.before-tool-call.diagnostics.js") = await import(
  moduleUrl("src/agents/agent-tools.before-tool-call.diagnostics.ts")
);

const keys = Array.from({ length: 10_000 }, (_, index) => {
  const expected = `agent:ops:${index % 4 === 0 ? "dashboard" : "subagent"}:synthetic-${index}`;
  return { input: index % 10 === 0 ? expected.toUpperCase() : expected, expected };
});
for (const { input, expected } of keys) {
  assert.equal(canonicalizeSessionKeyForAgent("ops", input), expected);
}
const mixedKey = "agent:ops:dashboard:media-mixed";
const explicitKey = "agent:ops:dashboard:media-explicit";
for (let index = 0; index < 64; index++) {
  createMediaGenerationOperation({
    taskId: `synthetic-media-${index}`,
    runId: `synthetic-media-${index}`,
    taskKind: "image_generation",
    requesterSessionKey: index < 32 ? mixedKey : explicitKey,
    requesterAgentId: index < 32 && index % 2 === 0 ? undefined : "ops",
    status: "running",
  });
}
assert.equal(listMediaGenerationOperations(mixedKey).length, 32);
assert.equal(listMediaGenerationOperations(explicitKey, "ops").length, 32);
assert.equal(listMediaGenerationOperations(mixedKey, "other").length, 0);

const skills = Array.from({ length: 200 }, (_, index) =>
  createCanonicalFixtureSkill({
    name: `synthetic-skill-${index}`,
    description: "Synthetic benchmark skill",
    filePath: `/synthetic/skills/${index}/SKILL.md`,
    baseDir: `/synthetic/skills/${index}`,
    source: "workspace",
  }),
);
const skillRequest = {
  toolName: "skills_read",
  toolParams: { name: "  synthetic-skill-199  " },
  ctx: { skillsSnapshot: { prompt: "", skills: [], discoverySkills: skills } },
};
assert.deepEqual(findSkillUsageMatch(skillRequest), {
  skillName: "synthetic-skill-199",
  skillSource: "workspace",
  activation: "read",
  skillFile: "/synthetic/skills/199/SKILL.md",
});

const workloads = [
  {
    name: "session-key",
    run: (index: number) => {
      const key = keys[index % keys.length];
      assert.ok(key);
      return canonicalizeSessionKeyForAgent("ops", key.input).length;
    },
    expected: keys.reduce((sum, key) => sum + key.expected.length, 0),
  },
  {
    name: "media-mixed-owner",
    run: () => listMediaGenerationOperations(mixedKey).length,
    expected: 320_000,
  },
  {
    name: "media-explicit-owner",
    run: () => listMediaGenerationOperations(explicitKey, "ops").length,
    expected: 320_000,
  },
  {
    name: "skill-lookup",
    run: () => findSkillUsageMatch(skillRequest)?.skillName.length ?? 0,
    expected: 10_000 * "synthetic-skill-199".length,
  },
];
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
}
try {
  for (const workload of workloads) {
    for (let index = 0; index < 10_000; index++) {
      workload.run(index);
    }
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    let checksum = 0;
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      const cpu = process.threadCpuUsage();
      for (let index = 0; index < 2000; index++) {
        checksum += workload.run(sample * 2000 + index);
      }
      const used = process.threadCpuUsage(cpu);
      samples.push({
        elapsedMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
    let sampledBytes: number | undefined;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      sampledBytes = 0;
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    assert.equal(checksum, workload.expected);
    console.log(
      JSON.stringify({
        workload: workload.name,
        operations: 10_000,
        checksum,
        sampledBytes,
        samples,
        load: loadavg(),
      }),
    );
  }
} finally {
  if (values.allocations) {
    inspector.disconnect();
  }
}
