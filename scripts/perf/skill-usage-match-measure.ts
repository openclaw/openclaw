/**
 * Owner cost for 200 skills and 10,000 read-tool calls; no Gateway, DB or discovery I/O.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-usage-match-measure.ts
 *   [timing|allocation|cpu] [owner.ts] [profile-output]
 * Preserve the baseline diagnostics module beside its source, pass its path, then
 * alternate five baseline/candidate pairs. Repeat baseline for A/A controls.
 * Timing excludes profiler overhead. Allocation includes collected objects. Cold
 * preparation is measured separately; full emitted matches contribute to the digest.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSyntheticSourceInfo } from "../../src/skills/loading/skill-contract.js";
import { prepareSkillReadIndex } from "../../src/skills/runtime/skill-read-index.js";
import type { SkillSnapshot } from "../../src/skills/types.js";
import { resolveSkillReadPath } from "../../src/skills/workspace-skill-read-path.js";

const [mode = "timing", owner = "src/agents/agent-tools.before-tool-call.diagnostics.ts", output] =
  process.argv.slice(2);
assert(["timing", "allocation", "cpu"].includes(mode));
assert(global.gc, "Use --expose-gc");
const { findSkillUsageMatch } = (await import(
  pathToFileURL(path.resolve(owner)).href
)) as typeof import("../../src/agents/agent-tools.before-tool-call.diagnostics.js");
const snapshot: SkillSnapshot = {
  prompt: "Synthetic catalog",
  skills: [],
  resolvedSkills: Array.from({ length: 200 }, (_, i) => {
    const baseDir = `/synthetic/skills/guide-${i}`;
    const filePath =
      i % 5 === 0 ? `node://synthetic/skills/guide-${i}/SKILL.md` : `${baseDir}/SKILL.md`;
    return {
      name: `guide-${i}`,
      description: "Synthetic guide",
      baseDir,
      filePath,
      fileHost: i % 3 === 0 ? "workspace" : "gateway",
      source: "openclaw-managed",
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-managed" }),
      disableModelInvocation: false,
    };
  }),
};
const requests = [
  ...snapshot.resolvedSkills!.map((skill) => ({
    toolName: "read",
    toolParams: { path: resolveSkillReadPath(skill) },
    ctx: { skillsSnapshot: snapshot },
  })),
  ...Array.from({ length: 100 }, (_, i) => ({
    toolName: "read",
    toolParams: { path: `/synthetic/workspace/source-${i}.ts` },
    ctx: { skillsSnapshot: snapshot },
  })),
];
const coldCpu = process.threadCpuUsage();
const coldStart = performance.now();
if (!owner.includes("baseline")) {
  prepareSkillReadIndex(snapshot);
}
const coldMs = performance.now() - coldStart;
const coldUsage = process.threadCpuUsage(coldCpu);
const expected = requests.map((request) => findSkillUsageMatch(request));
const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
for (let i = 0; i < 3000; i++) {
  findSkillUsageMatch(requests[i % requests.length]!);
}
global.gc();
const inspector = new Session();
if (mode !== "timing") {
  inspector.connect();
}
if (mode === "allocation") {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
if (mode === "cpu") {
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
const loadBefore = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
let hits = 0;
for (let i = 0; i < 10000; i++) {
  if (findSkillUsageMatch(requests[i % requests.length]!)) {
    hits++;
  }
}
const wallMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  if (output) {
    writeFileSync(output, JSON.stringify(profile));
  }
}
if (mode === "cpu") {
  assert(output, "CPU profile needs output path");
  const { profile } = await inspector.post("Profiler.stop");
  writeFileSync(output, JSON.stringify(profile));
}
if (mode !== "timing") {
  inspector.disconnect();
}
assert.equal(hits, 6700);
console.log(
  JSON.stringify({
    mode,
    owner,
    skills: 200,
    calls: 10000,
    hits,
    digest,
    coldMs,
    coldCpuMs: (coldUsage.user + coldUsage.system) / 1000,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    loadBefore,
    loadAfter: loadavg(),
    node: process.version,
  }),
);
