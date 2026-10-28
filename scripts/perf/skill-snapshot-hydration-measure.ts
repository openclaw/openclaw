/**
 * Persisted skill-snapshot hydration through the real discovery/projection owner.
 * node --import ./scripts/tsx.mjs scripts/perf/skill-snapshot-hydration-measure.ts --output .local/skills-base.json
 * Alternate baseline/candidate >=5 times; repeat separately with --allocations.
 * Each run hydrates 32 retained sessions sharing 256 synthetic skills, 3,200 times,
 * including project skills that shadow bundled skills. Reports worker completions
 * and main-thread CPU; allocation sampling runs separately from timing.
 * --baseline-dir uses the existing sparse source overlay preload; save the baseline
 * src/skills/runtime/session-snapshot.ts beneath that directory before editing.
 * Setup and first worker projection are outside the measured warm window. This
 * owner microbenchmark does not measure Gateway startup, admission, or remote I/O.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { SkillSnapshot } from "../../src/skills/types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    allocations: { type: "boolean" },
    "baseline-dir": { type: "string" },
  },
});
assert(values.output, "--output is required");
const output = path.resolve(values.output);
const ownerSource = path.resolve(
  values["baseline-dir"] ?? ".",
  "src/skills/runtime/session-snapshot.ts",
);
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerSource))
  .digest("hex");
await mkdir(path.dirname(output), { recursive: true });
const fixture = await mkdtemp(path.join(path.dirname(output), "skill-hydration-fixture-"));
Object.assign(process.env, {
  HOME: fixture,
  USERPROFILE: fixture,
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(fixture, "bundled-skills"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, "bundled-plugins"),
});
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { resolveReusableWorkspaceSkillSnapshot } =
  await import("../../src/skills/runtime/session-snapshot.js");
const { closeSkillsWatchers } = await import("../../src/skills/runtime/refresh.js");
const { stripRuntimeOnlySessionSkillsFields } =
  await import("../../src/config/sessions/store-entry-shape.js");
const inspector = values.allocations ? new Session() : undefined;
try {
  const workspaceDir = path.join(fixture, "workspace");
  const skillCount = 256;
  for (let index = 0; index < skillCount; index++) {
    const name = `synthetic-${String(index).padStart(3, "0")}`;
    const roots =
      index < 32
        ? [path.join(workspaceDir, ".agents", "skills"), path.join(fixture, "bundled-skills")]
        : [path.join(workspaceDir, "skills")];
    for (const root of roots) {
      const dir = path.join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Synthetic skill ${index}\n---\nSynthetic instructions.\n`,
      );
    }
  }
  const params = {
    workspaceDir,
    config: {
      plugins: { enabled: false },
      skills: {
        load: { watch: false },
        limits: {
          maxSkillsLoadedPerSource: skillCount,
          maxSkillsInPrompt: skillCount,
          maxSkillsPromptChars: 128_000,
        },
      },
    },
    // Exercise reply preparation's root registration; passive timers are disabled above.
    watch: true,
  };
  const initial = (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot;
  assert.equal(initial.skills.length, skillCount);
  const saved = stripRuntimeOnlySessionSkillsFields({
    sessionId: "synthetic-session",
    updatedAt: 1,
    skillsSnapshot: initial,
  }).skillsSnapshot;
  assert(saved);
  const sessions = Array.from({ length: 32 }, () => structuredClone(saved));
  const hydrate = (index: number) =>
    resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: sessions[index % sessions.length],
    });
  for (let index = 0; index < 64; index++) {
    await hydrate(index);
  }
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const iterations = 3_200;
  let workerRoundTrips = 0;
  const tasks = channel("openclaw.worker.task");
  const countTask = () => {
    workerRoundTrips++;
  };
  tasks.subscribe(countTask);
  const threadCpuBefore = process.threadCpuUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let last: SkillSnapshot | undefined;
  for (let index = 0; index < iterations; index++) {
    last = (await hydrate(index)).snapshot;
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const threadCpu = process.threadCpuUsage(threadCpuBefore);
  tasks.unsubscribe(countTask);
  let sampledBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    await writeFile(`${output}.heapprofile`, JSON.stringify(profile));
  }
  assert.equal(last?.prompt, initial.prompt);
  assert.equal(last?.discoverySkills?.length, skillCount);
  const result = {
    ownerSha256,
    iterations,
    sessionCount: sessions.length,
    skillCount,
    mode: inspector ? "allocation" : "timing",
    elapsedMs,
    processCpuMs: (cpu.user + cpu.system) / 1_000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1_000,
    workerRoundTrips,
    sampledBytes,
    sampledBytesPerHydration: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    hostLoad: os.loadavg(),
    memory: process.memoryUsage(),
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
  await closeSkillsWatchers();
  await rm(fixture, { recursive: true, force: true });
}
