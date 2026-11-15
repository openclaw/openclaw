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
 * --fresh --sessions 1000 retains fresh sessions with 135 skills after normal eligibility
 * checks. Use --expose-gc for retained heap, and --snapshot <path> for owner attribution.
 * --fixture-dir <unused-path> gives serial A/B processes identical source paths; the
 * owned fixture is removed on completion. Digests normalize this root and the
 * process-start-based snapshot version; all other catalog bytes remain exact.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { SkillSnapshot } from "../../src/skills/types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    allocations: { type: "boolean" },
    "baseline-dir": { type: "string" },
    fresh: { type: "boolean" },
    sessions: { type: "string", default: "1000" },
    snapshot: { type: "string" },
    "fixture-dir": { type: "string" },
  },
});
assert(values.output, "--output is required");
const freshSessions = Number(values.sessions);
assert(Number.isSafeInteger(freshSessions) && freshSessions > 0 && freshSessions <= 100_000);
assert(!values.snapshot || global.gc, "--snapshot requires --expose-gc");
const output = path.resolve(values.output);
const ownerSource = path.resolve(
  values["baseline-dir"] ?? ".",
  "src/skills/runtime/session-snapshot.ts",
);
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerSource))
  .digest("hex");
await mkdir(path.dirname(output), { recursive: true });
const fixture = values["fixture-dir"]
  ? path.resolve(values["fixture-dir"])
  : await mkdtemp(path.join(path.dirname(output), "skill-hydration-fixture-"));
if (values["fixture-dir"]) {
  await mkdir(fixture);
}
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
  const skillCount = values.fresh ? 135 : 256;
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
        `---\nname: ${name}\ndescription: Synthetic skill ${index}\n---\n${"Synthetic instructions.\n".repeat(values.fresh ? 200 : 1)}`,
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
  const sessions = values.fresh ? [] : Array.from({ length: 32 }, () => structuredClone(saved));
  const hydrate = (index: number) =>
    resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: values.fresh ? undefined : sessions[index % sessions.length],
    });
  for (let index = 0; index < 64; index++) {
    await hydrate(index);
  }
  const collect = async () => {
    if (global.gc) {
      for (let pass = 0; pass < 3; pass++) {
        await nextTurn();
        global.gc();
      }
    }
  };
  await collect();
  const heapBefore = global.gc ? process.memoryUsage().heapUsed : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const iterations = values.fresh ? freshSessions : 3_200;
  const retained: SkillSnapshot[] = [];
  const timings: number[] = [];
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
    const operationStarted = performance.now();
    last = (await hydrate(index)).snapshot;
    timings.push(performance.now() - operationStarted);
    if (values.fresh) {
      retained.push(last);
    }
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
  assert(last);
  assert.equal(last.prompt, initial.prompt);
  assert.equal(last.discoverySkills?.length, skillCount);
  await collect();
  const retainedBytes =
    heapBefore === undefined ? undefined : process.memoryUsage().heapUsed - heapBefore;
  if (values.snapshot) {
    await mkdir(path.dirname(path.resolve(values.snapshot)), { recursive: true });
    writeHeapSnapshot(path.resolve(values.snapshot));
  }
  const digest = createHash("sha256");
  for (const snapshot of values.fresh ? retained : [last]) {
    digest.update(
      JSON.stringify({ ...snapshot, version: 0 }).replaceAll(fixture, "/synthetic/fixture"),
    );
  }
  timings.sort((a, b) => a - b);
  const result = {
    ownerSha256,
    snapshotVersion: last.version,
    iterations,
    sessionCount: values.fresh ? freshSessions : sessions.length,
    skillCount,
    flow: values.fresh ? "fresh" : "hydration",
    mode: inspector ? "allocation" : "timing",
    elapsedMs,
    processCpuMs: (cpu.user + cpu.system) / 1_000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1_000,
    p50Ms: timings[Math.floor(timings.length * 0.5)],
    p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
    retainedBytes,
    uniqueSnapshots: new Set(retained).size,
    uniqueSkillObjects: new Set(retained.flatMap((snapshot) => snapshot.discoverySkills ?? []))
      .size,
    uniqueMetadataObjects: new Set(retained.flatMap((snapshot) => snapshot.skills)).size,
    digest: digest.digest("hex"),
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
