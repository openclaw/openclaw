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
 * --skills 96 --custody includes real retained Gateway state ownership checks.
 * --background-files 62000 adds 1.116 GB of unrelated synthetic workspace files.
 * Counters cover Node realpathSync.native/lstatSync, not native-internal syscalls.
 * Allocation sampling includes collected objects on the main thread only;
 * process CPU and memory also include the discovery worker. No forced GC.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import type { syncWorkspaceSkills } from "../../src/skills/loading/workspace-skill-sync.runtime.js";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "10" },
    mode: { type: "string", default: "all" },
    allocations: { type: "boolean", default: false },
    skills: { type: "string", default: "40" },
    "background-files": { type: "string", default: "0" },
    custody: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const skillCount = Number(values.skills);
const backgroundFiles = Number(values["background-files"]);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(Number.isSafeInteger(skillCount) && skillCount > 0, "--skills must be positive");
assert(Number.isSafeInteger(backgroundFiles) && backgroundFiles >= 0, "Invalid --background-files");
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
const { captureSandboxStateOwner } = await import("../../src/agents/sandbox/state-owner.js");
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.js");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.js");
const { resolveOpenClawStateSqlitePath } =
  await import("../../src/state/openclaw-state-db.paths.js");
if (values.custody) {
  // Custody reads file identity only; keep its path present as on an initialized Gateway.
  await mkdir(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true });
  await writeFile(resolveOpenClawStateSqlitePath(), "synthetic identity fixture\n");
}
const custody = values.custody
  ? acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        processNamespace: readGatewayLockProcessNamespace(),
        createdAt: new Date().toISOString(),
        configPath: process.env.OPENCLAW_CONFIG_PATH!,
        role: "gateway",
      },
    })
  : undefined;
const assertOwner = custody ? await captureSandboxStateOwner() : undefined;
let checks = 0;

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
  const background = path.join(workspace, "unrelated-project");
  await mkdir(background, { recursive: true });
  for (let index = 0; index < backgroundFiles; index++) {
    await writeFile(path.join(background, `file-${index}.txt`), "x".repeat(18_000));
  }
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
      assertCurrent: assertOwner
        ? () => {
            checks++;
            assertOwner();
          }
        : undefined,
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
    const observer = new PerformanceObserver((batch) =>
      recordGcCollections(batch.getEntries(), collections, started, ended),
    );
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
      checks = 0;
      let realpaths = 0;
      let lstats = 0;
      const realpath = fs.realpathSync.native;
      const lstat = fs.lstatSync;
      fs.realpathSync.native = new Proxy(realpath, {
        apply(target, receiver, args) {
          realpaths++;
          return Reflect.apply(target, receiver, args);
        },
      });
      fs.lstatSync = new Proxy(lstat, {
        apply(target, receiver, args) {
          lstats++;
          return Reflect.apply(target, receiver, args);
        },
      });
      started = performance.now();
      try {
        for (const target of targets) {
          const before = performance.now();
          deliveries.push(await sync(target));
          latency.push(performance.now() - before);
        }
      } finally {
        fs.realpathSync.native = realpath;
        fs.lstatSync = lstat;
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
      recordGcCollections(observer.takeRecords(), collections, started, ended);
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
        authorityChecksPerSync: checks / iterations,
        nodeRealpathsPerSync: realpaths / iterations,
        nodeLstatsPerSync: lstats / iterations,
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
    backgroundFiles,
    custody: values.custody,
    filesPerSkill: 9,
    mode: inspector ? "allocation" : "timing",
    results,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  custody?.release();
  inspector?.disconnect();
  await drainGlobalSingletonLifecycleState();
  await rm(fixture, { recursive: true, force: true });
}
