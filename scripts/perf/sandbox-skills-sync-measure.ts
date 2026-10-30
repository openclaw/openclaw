/**
 * Synthetic sandbox skill delivery through the real sync/discovery owners.
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-skills-sync-measure.ts \
 *   --output .local/skills-sync-base.json --iterations 10 --mode cold
 * Alternate baseline/candidate >=5 times; repeat separately with --allocations.
 * --owner selects an alternate workspace-skill-sync.runtime.ts in this checkout.
 * Modes: cold = new destinations, warm = retained snapshot/destination,
 * refreshed = retained destinations after one supporting-file revision change.
 * Forty skills have nine files each, including hidden instructions and nested
 * references/scripts. Discovery, fixture writes and content verification are
 * outside measurement. This measures skills_sync, not container startup/layout.
 * Allocation sampling includes collected objects on the main thread only;
 * process CPU and memory also include the discovery worker. No forced GC.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import type { syncWorkspaceSkills } from "../../src/skills/loading/workspace-skill-sync.runtime.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "10" },
    mode: { type: "string", default: "all" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
const modes = values.mode === "all" ? ["cold", "warm", "refreshed"] : [values.mode];
assert(
  modes.every((mode) => ["cold", "warm", "refreshed"].includes(mode)),
  "Invalid --mode",
);
const output = path.resolve(values.output ?? `.local/sandbox-skills-sync-${process.pid}.json`);
await mkdir(path.dirname(output), { recursive: true });
const fixture = await mkdtemp(path.join(path.dirname(output), "skills-sync-fixture-"));
Object.assign(process.env, {
  HOME: fixture,
  USERPROFILE: fixture,
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_CONFIG_PATH: path.join(fixture, "openclaw.json"),
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(fixture, "bundled-skills"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, "bundled-plugins"),
});
const ownerPath = values.owner
  ? path.resolve(values.owner)
  : fileURLToPath(
      new URL("../../src/skills/loading/workspace-skill-sync.runtime.ts", import.meta.url),
    );
const owner = (await import(pathToFileURL(ownerPath).href)) as {
  syncWorkspaceSkills: typeof syncWorkspaceSkills;
};
const { buildSkillSnapshot } = await import("../../src/skills/loading/workspace-skill-prompt.js");
const { getSkillsSnapshotVersion, markSkillsSupportingFilesChanged } =
  await import("../../src/skills/runtime/refresh-state.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const inspector = values.allocations ? new Session() : undefined;

function distribution(samples: number[]) {
  const ordered = samples.toSorted((a, b) => a - b);
  const totalMs = samples.reduce((sum, value) => sum + value, 0);
  return {
    samples: samples.length,
    totalMs,
    meanMs: samples.length ? totalMs / samples.length : 0,
    p50Ms: ordered[Math.ceil(samples.length * 0.5) - 1] ?? null,
    p95Ms: ordered[Math.ceil(samples.length * 0.95) - 1] ?? null,
    maxMs: ordered.at(-1) ?? null,
  };
}

try {
  inspector?.connect();
  const workspace = path.join(fixture, "workspace");
  const expected = new Map<string, string>();
  const skillCount = 40;
  for (let index = 0; index < skillCount; index++) {
    const name = `synthetic-${String(index).padStart(2, "0")}`;
    expected.set(
      `${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Synthetic skill ${index}\n${index % 7 === 0 ? "disable-model-invocation: true\n" : ""}---\nSynthetic instructions.\n`,
    );
    for (let file = 0; file < 8; file++) {
      const directory = file % 2 ? "scripts/helpers" : "references/topics";
      expected.set(
        `${name}/${directory}/file-${file}.txt`,
        `${name} file ${file}\n${"x".repeat(4096)}\n`,
      );
    }
  }
  for (const [relative, content] of expected) {
    const file = path.join(workspace, "skills", relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const options = {
    config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
    bundledSkillsDir: path.join(fixture, "bundled-skills"),
    managedSkillsDir: path.join(fixture, "managed-skills"),
    pluginSkillsDir: path.join(fixture, "plugin-skills"),
  };
  const snapshot = await buildSkillSnapshot(workspace, {
    ...options,
    snapshotVersion: getSkillsSnapshotVersion(workspace),
  });
  assert.equal(snapshot.skills.length, skillCount);
  const sync = (targetWorkspaceDir: string) =>
    owner.syncWorkspaceSkills({
      ...options,
      sourceWorkspaceDir: workspace,
      targetWorkspaceDir,
      skillsSnapshot: snapshot,
    });
  await sync(path.join(fixture, "discovery-warmup"));
  const results = [];
  for (const mode of modes) {
    const targets = Array.from({ length: iterations }, (_, index) =>
      path.join(fixture, mode, mode === "warm" ? "shared" : String(index)),
    );
    if (mode !== "cold") {
      for (const target of new Set(targets)) {
        await sync(target);
      }
      if (mode === "warm") {
        await sync(targets[0]!);
      } else {
        const changed = "synthetic-00/references/topics/file-0.txt";
        const content = `${expected.get(changed)}updated\n`;
        await writeFile(path.join(workspace, "skills", changed), content);
        expected.set(changed, content);
        markSkillsSupportingFilesChanged({ workspaceDir: workspace });
      }
    }
    const collections: { kind: number; ms: number }[] = [];
    let started = Infinity;
    let ended = Infinity;
    const recordGc = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (entry.startTime >= started && entry.startTime < ended) {
          collections.push({
            kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
            ms: entry.duration,
          });
        }
      }
    };
    const observer = new PerformanceObserver((batch) => recordGc(batch.getEntries()));
    observer.observe({ entryTypes: ["gc"] });
    try {
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const memoryBefore = process.memoryUsage();
      const hostLoadBefore = os.loadavg();
      const cpuBefore = process.cpuUsage();
      const threadBefore = process.threadCpuUsage();
      const latency: number[] = [];
      const deliveries = [];
      started = performance.now();
      for (const target of targets) {
        const before = performance.now();
        deliveries.push(await sync(target));
        latency.push(performance.now() - before);
      }
      ended = performance.now();
      const thread = process.threadCpuUsage(threadBefore);
      const cpu = process.cpuUsage(cpuBefore);
      const memoryAfter = process.memoryUsage();
      const hostLoadAfter = os.loadavg();
      const profile = inspector
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      await nextTurn();
      recordGc(observer.takeRecords());
      const sampledBytes = profile?.samples.reduce((sum, sample) => sum + sample.size, 0);
      if (profile) {
        await writeFile(`${output}.${mode}.heapprofile`, JSON.stringify(profile));
      }
      for (const delivery of deliveries) {
        assert.equal(delivery.length, skillCount);
      }
      for (const target of new Set(targets)) {
        const directory = path.join(target, "skills");
        const files = await listDirectoryTreeStrict(directory);
        assert.equal(files.filter((file) => file.dirent.isFile()).length, expected.size + 2);
        for (const [relative, content] of expected) {
          assert.equal(await readFile(path.join(directory, relative), "utf8"), content);
        }
      }
      results.push({
        workload: mode,
        iterations,
        elapsedMs: ended - started,
        latency: distribution(latency),
        processCpuMs: (cpu.user + cpu.system) / 1000,
        mainThreadCpuMs: (thread.user + thread.system) / 1000,
        sampledBytes,
        sampledBytesPerSync: sampledBytes === undefined ? undefined : sampledBytes / iterations,
        gc: distribution(collections.map((entry) => entry.ms)),
        gcByKind: Object.fromEntries(
          [...new Set(collections.map((entry) => entry.kind))].map((kind) => [
            kind,
            distribution(
              collections.filter((entry) => entry.kind === kind).map((entry) => entry.ms),
            ),
          ]),
        ),
        memoryBefore,
        memoryAfter,
        hostLoadBefore,
        hostLoadAfter,
      });
    } finally {
      observer.disconnect();
    }
  }
  const result = {
    ownerPath,
    skillCount,
    filesPerSkill: 9,
    mode: inspector ? "allocation" : "timing",
    results,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
  await drainGlobalSingletonLifecycleState();
  await rm(fixture, { recursive: true, force: true });
}
