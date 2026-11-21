// Run on a disposable btrfs mount with a frozen compiled-subprocess runtime:
// node scripts/perf/worktree-template-prepare-measure.mts --runtime <runtime-root> --root <btrfs-root> --label <arm>
// Mount each runtime at its compiler-recorded path before running (external worker URLs).
// Acceptance: two baseline A/A controls, five alternating A/B pairs; stale preparation
// loses physical retirement, warm/apply and total prepare+GC must not regress >20%.
// Repeat with --allocation separately. All data is synthetic; no Gateway/model is run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { prepareWorktreeTemplate } from "../../src/agents/worktrees/template-cache.js";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    root: { type: "string" },
    label: { type: "string" },
    allocation: { type: "boolean" },
    profile: { type: "string" },
  },
});
assert(values.runtime && values.root && values.label);
const runtime = path.resolve(values.runtime);
const root = path.resolve(values.root);
const command = (exe: string, args: string[]) => execFileSync(exe, args, { encoding: "utf8" });
const git = (cwd: string, args: string[]) => command("git", ["-C", cwd, ...args]).trim();
// Locate public exports in the frozen compiler output without adding production test seams.
async function exported(symbol: string) {
  const dist = path.join(runtime, "dist");
  for (const file of fs.readdirSync(dist)) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const text = fs.readFileSync(path.join(dist, file), "utf8");
    const exports = text.match(/export \{([^}]+)\};?\s*$/u)?.[1];
    const match = exports?.match(new RegExp(`\\b${symbol} as (\\w+)\\b`, "u"));
    if (match) {
      return (await import(pathToFileURL(path.join(dist, file)).href))[match[1]!];
    }
  }
  throw new Error(`Missing compiled export: ${symbol}`);
}
const prepare: typeof prepareWorktreeTemplate = await exported("prepareWorktreeTemplate");
const collect: typeof import("../../src/agents/worktrees/template-cache.js").collectWorktreeTemplates =
  await exported("collectWorktreeTemplates");
const detect: typeof import("../../src/agents/worktrees/filesystem-backend.js").detectWorktreeFilesystemBackend =
  await exported("detectWorktreeFilesystemBackend");
const close: typeof import("../../src/state/openclaw-state-db.js").closeOpenClawStateDatabaseAsync =
  await exported("closeOpenClawStateDatabaseAsync");
const timing: typeof import("../../src/agents/worktrees/preparation-timing.js").withWorktreePreparationTiming =
  await exported("withWorktreePreparationTiming");
const phase: typeof import("../../src/agents/worktrees/preparation-timing.js").timeWorktreePreparationPhase =
  await exported("timeWorktreePreparationPhase");
const drain: typeof import("../../src/shared/global-singleton.js").drainGlobalSingletonLifecycleState =
  await exported("drainGlobalSingletonLifecycleState");
const guard = { commitGuard: () => {} };
const backend = await detect(root, guard);
assert.equal(backend?.id, "btrfs");
assert(backend);
const seed = path.join(root, "seed");
if (!fs.existsSync(seed)) {
  await backend.createTemplate(seed, guard);
  const payload = Buffer.alloc(17742, 120);
  for (let i = 0; i < 62000; i++) {
    const directory = path.join(seed, `group-${Math.floor(i / 100)}`);
    if (i % 100 === 0) {
      fs.mkdirSync(directory);
    }
    fs.writeFileSync(path.join(directory, `file-${i}.txt`), payload);
  }
  git(seed, ["init", "-q", "-b", "fixture"]);
  git(seed, ["add", "."]);
  git(seed, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "synthetic",
  ]);
  fs.mkdirSync(path.join(root, "siblings"));
  for (let i = 0; i < 2025; i++) {
    command("btrfs", ["subvolume", "snapshot", seed, path.join(root, "siblings", String(i))]);
  }
}
const packDirectory = path.join(seed, ".git/objects/pack");
if (fs.readdirSync(packDirectory).filter((file) => file.endsWith(".pack")).length === 0) {
  for (let i = 0; i < 1239; i++) {
    const object = execFileSync("git", ["-C", seed, "hash-object", "-w", "--stdin"], {
      input: `synthetic-pack-${i}`,
      encoding: "utf8",
    });
    execFileSync("git", ["-C", seed, "pack-objects", path.join(packDirectory, "pack")], {
      input: object,
    });
  }
}
const runRoot = fs.mkdtempSync(path.join(root, "sample-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(runRoot, "state") };
const commit = git(seed, ["rev-parse", "HEAD"]);
let validates = 0;
let builds = 0;
const params: Parameters<typeof prepare>[0] = {
  env,
  now: Date.now,
  options: guard,
  cacheKey: "synthetic",
  contentKey: commit,
  repoRoot: seed,
  commonDir: path.join(seed, ".git"),
  worktreeRoot: runRoot,
  sourceCommit: commit,
  backend: "btrfs",
  requireSpace: async () => {},
  validate: async (record) => {
    validates++;
    return git(record.path, ["status", "--porcelain", "--untracked-files=all", "--ignored"]) === "";
  },
  prepare: async (record) => {
    builds++;
    await backend.cloneTemplate(seed, record.path, guard);
  },
};
const inspector = new Session();
inspector.connect();
type AllocationNode = { selfSize: number; children: AllocationNode[] };
const sum = (node: AllocationNode): number =>
  node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
const ticks = Number(command("getconf", ["CLK_TCK"]));
const childrenCpu = () => {
  const fields = fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / ticks;
};
const metrics: Record<string, unknown>[] = [];
async function measure<T>(name: string, run: () => Promise<T>) {
  if (values.allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.cpuUsage();
  const childBefore = childrenCpu();
  const start = performance.now();
  const result = await run();
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(before);
  const heap = values.allocation ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  metrics.push({
    name,
    wallMs,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    waitedChildCpuMs: childrenCpu() - childBefore,
    sampledMainJsBytes: heap ? sum(heap.profile.head) : null,
  });
  return result;
}
try {
  const first = await prepare(params);
  assert(first);
  await first.release();
  command("btrfs", ["filesystem", "sync", root]);
  if (values.profile) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const warm = await measure("warmPrepare", () =>
    timing("managed", () => phase("templatePrepare", () => prepare(params))),
  );
  assert(warm);
  assert.equal(warm.id, first.id);
  await warm.release();
  fs.writeFileSync(path.join(warm.path, "untracked"), "invalid idle template");
  const fresh = await measure("stalePrepare", () =>
    timing("managed", () => phase("templatePrepare", () => prepare(params))),
  );
  assert(fresh);
  assert.notEqual(fresh.id, warm.id);
  const deferred = fs.existsSync(warm.path);
  const destination = path.join(runRoot, "applied");
  await measure("templateApply", () => backend.cloneTemplate(fresh.path, destination, guard));
  assert.equal(fs.readFileSync(path.join(destination, "group-0/file-0.txt")).length, 17742);
  assert.equal(git(destination, ["status", "--porcelain"]), "");
  await measure("retiredGc", () =>
    collect(env, Date.now() + 1, guard, (error) => {
      throw error;
    }),
  );
  assert(!fs.existsSync(warm.path));
  assert(fs.existsSync(fresh.path));
  await fresh.release();
  if (values.profile) {
    fs.writeFileSync(
      values.profile,
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  console.log(
    JSON.stringify({
      label: values.label,
      allocation: Boolean(values.allocation),
      node: process.version,
      files: 62000,
      payloadBytes: 1100004000,
      siblingSnapshots: 2025,
      packs: 1239,
      deferred,
      validates,
      builds,
      load: loadavg(),
      metrics,
    }),
  );
  await collect(env, Date.now() + 1, guard, (error) => {
    throw error;
  });
  command("btrfs", ["subvolume", "delete", destination]);
} finally {
  inspector.disconnect();
  await close();
  await drain();
  command("btrfs", ["filesystem", "sync", root]);
  command("btrfs", ["subvolume", "sync", root]);
  fs.rmSync(runRoot, { recursive: true, force: true });
}
