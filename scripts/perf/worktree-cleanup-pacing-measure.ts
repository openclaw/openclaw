/**
 * Synthetic expired-cohort cleanup through GatewayScheduler -> managedWorktrees.gc ->
 * real Git snapshots and deletion. Never point --source or --output at real data.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-cleanup-pacing-measure.ts \
 *   --source <new-source-directory> --prepare --files 62000 --file-bytes 18432
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-cleanup-pacing-measure.ts \
 *   --source <prepared-source> --output <new-arm-directory> --worktrees 3
 *
 * Run two A/A controls followed by five serial interleaved A/B pairs. Select a pinned
 * sparse source overlay with OPENCLAW_BENCH_BASELINE_DIR. --profile writes a separate
 * main-thread CPU profile; all arms report exact main V8 allocated bytes and process
 * CPU (workers included, Git children excluded). Setup/verification/drainage are untimed.
 * Only scheduled waits are virtualized: filesystem, SQLite, snapshots and removal are
 * real. Report actual owner wall time separately from the logical maintenance timeline.
 * Acceptance: <=1 candidate admission/minute, identical complete snapshot contents,
 * and no >20% per-removal CPU/allocation regression beyond A/A spread. This fixture
 * does not reproduce Linux btrfs backrefs, physical cache misses, chat latency or a
 * large transcript database: this owner resolves session metadata for the selected
 * worktrees, not transcript bodies. The fixture has 5,000 real session metadata rows.
 * Checkouts hardlink immutable synthetic files to limit disk use;
 * the one edited file is unlinked before writing. Source setup is excluded from timing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
} from "../../src/agents/worktrees/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    prepare: { type: "boolean", default: false },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "18432" },
    worktrees: { type: "string", default: "3" },
    profile: { type: "boolean", default: false },
  },
});
assert(values.source, "--source is required");
const source = path.resolve(values.source);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Synthetic Benchmark",
      GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Benchmark",
      GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const fixturePath = path.join(source, "fixture.json");
if (values.prepare) {
  const files = Number(values.files);
  const fileBytes = Number(values["file-bytes"]);
  assert(Number.isSafeInteger(files) && files >= 1);
  assert(Number.isSafeInteger(fileBytes) && fileBytes >= 128);
  fs.mkdirSync(source);
  git(source, "init", "--quiet", "-b", "main", "--template=");
  const paths: string[] = [];
  for (let index = 0; index < files; index++) {
    const relative = `packages/${Math.floor(index / 100)}/module-${index}.ts`;
    const filename = path.join(source, relative);
    if (index % 100 === 0) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    fs.writeFileSync(filename, `// synthetic ${index}\n`.padEnd(fileBytes, "x"));
    paths.push(relative);
  }
  git(source, "add", "packages");
  git(source, "commit", "--quiet", "-m", "synthetic cleanup cohort");
  const snapshot = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(fixturePath, JSON.stringify({ files, fileBytes, snapshot, paths }));
  console.log(JSON.stringify({ prepared: source, files, bytes: files * fileBytes }));
  process.exit(0);
}
assert(values.output && global.gc, "--output and --expose-gc are required");
const output = path.resolve(values.output);
const worktrees = Number(values.worktrees);
assert(Number.isSafeInteger(worktrees) && worktrees >= 2);
fs.mkdirSync(output);
for (const directory of ["home", "tmp", "state"]) {
  fs.mkdirSync(path.join(output, directory));
}
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
  },
});
const config = {
  worktreeAcceleration: false,
  logging: {
    level: "info" as const,
    consoleLevel: "silent" as const,
    file: path.join(output, "runtime.log"),
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config, config);
const { managedWorktrees } = await import("../../src/agents/worktrees/service.js");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { runOpenClawAgentWriteTransaction, openOpenClawAgentDatabase } =
  await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { startWorktreeMaintenance } = await import("../../src/gateway/worktree-maintenance.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  files: number;
  fileBytes: number;
  snapshot: string;
  paths: string[];
};
const repo = path.join(output, "repo");
git(output, "clone", "--quiet", "--shared", "--no-checkout", source, repo);
git(repo, "config", "maintenance.auto", "false");
const { fingerprint } = await managedWorktrees.resolveRepositoryIdentity(repo);
const records: ManagedWorktreeRecord[] = [];
for (let index = 0; index < worktrees; index++) {
  const id = `21882188-2188-4188-8188-${String(index).padStart(12, "0")}`;
  const checkout = path.join(output, "state", "worktrees", fingerprint, id);
  const branch = `openclaw/synthetic-${index}`;
  git(
    repo,
    "worktree",
    "add",
    "--quiet",
    "--no-checkout",
    "-b",
    branch,
    checkout,
    fixture.snapshot,
  );
  let previousDirectory = "";
  for (const relative of fixture.paths) {
    const filename = path.join(checkout, relative);
    const directory = path.dirname(filename);
    if (directory !== previousDirectory) {
      fs.mkdirSync(directory, { recursive: true });
      previousDirectory = directory;
    }
    fs.linkSync(path.join(source, relative), filename);
  }
  git(checkout, "reset", "--quiet", "--mixed", "HEAD");
  fs.unlinkSync(path.join(checkout, fixture.paths[0]!));
  fs.writeFileSync(path.join(checkout, fixture.paths[0]!), "// synthetic user edit\n");
  fs.writeFileSync(path.join(checkout, "user-notes.txt"), "synthetic unsaved work\n");
  const record: ManagedWorktreeRecord = {
    id,
    name: `synthetic-${index}`,
    repoFingerprint: fingerprint,
    repoRoot: repo,
    path: checkout,
    branch,
    baseRef: "main",
    ownerKind: "session",
    ownerId: `agent:main:synthetic-${index}`,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, record, { provisionedPaths: [] });
  records.push(record);
  console.error(JSON.stringify({ prepared: records.length, worktrees, files: fixture.files }));
}
const sessions = 5_000;
for (let offset = 0; offset < sessions; offset += 100) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = offset; index < Math.min(offset + 100, sessions); index++) {
        const record = records[index];
        writeSessionEntry(database, `agent:main:synthetic-${index}`, {
          sessionId: `synthetic-${index}`,
          updatedAt: 1,
          lifecycleRevision: `synthetic-${index}`,
          status: "done",
          ...(record
            ? { worktree: { id: record.id, branch: record.branch, repoRoot: record.repoRoot } }
            : {}),
        });
      }
    },
    { agentId: "main" },
  );
}
const agentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
agentDatabase.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const agentDatabaseBytes = fs.statSync(agentDatabase.path).size;
let skippedWaitMs = 0;
const now = () => Date.now() + skippedWaitMs;
const scheduler = new GatewayScheduler({
  clock: {
    now,
    monotonicNow: () => performance.now() + skippedWaitMs,
    arm: (run, delayMs) => {
      // Park the unrelated hourly recurrence; only cleanup continuation timers advance.
      if (delayMs > 10 * 60_000) {
        return () => {};
      }
      const timer = setTimeout(() => {
        skippedWaitMs += delayMs;
        void run();
      }, 0);
      return () => clearTimeout(timer);
    },
  },
});
const removals: Array<{ id: string; atMs: number; wallMs: number }> = [];
const admissions: number[] = [];
const gc = managedWorktrees.gc.bind(managedWorktrees);
managedWorktrees.gc = async (params) => {
  if (params?.beforeRemoval) {
    const beforeRemoval = params.beforeRemoval;
    params.beforeRemoval = async () => {
      await beforeRemoval();
      admissions.push(now());
    };
  }
  return await gc(params);
};
const remove = managedWorktrees.remove.bind(managedWorktrees);
managedWorktrees.remove = async (input) => {
  const started = performance.now();
  const atMs = now();
  try {
    return await remove(input);
  } finally {
    removals.push({ id: input.id, atMs, wallMs: performance.now() - started });
  }
};
const inspector = new Session();
let owner: ReturnType<typeof startWorktreeMaintenance> | undefined;
try {
  global.gc();
  if (values.profile) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const allocationBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocationBefore), "Runtime must expose exact V8 allocation counters");
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const mainCpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const result = await new Promise<ManagedWorktreeGcResult>((resolve, reject) => {
    owner = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig: () => config,
      onComplete: resolve,
      onError: (message) => reject(new Error(message)),
    });
    owner.request();
  });
  const wallMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpuBefore);
  const mainCpu = process.threadCpuUsage(mainCpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
  if (values.profile) {
    fs.writeFileSync(
      path.join(output, "cpu.cpuprofile"),
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
    inspector.disconnect();
  }
  assert.equal(removals.length, worktrees);
  const archived = new Map(
    (await managedWorktrees.listRegistryRecords()).map((record) => [record.id, record]),
  );
  const trees: string[] = [];
  for (const record of records) {
    const current = archived.get(record.id);
    assert(current?.removedAt !== undefined && current.snapshotRef);
    assert(!fs.existsSync(record.path));
    assert.equal(
      git(repo, "show", `${current.snapshotRef}:${fixture.paths[0]}`),
      "// synthetic user edit",
    );
    assert.equal(
      git(repo, "show", `${current.snapshotRef}:user-notes.txt`),
      "synthetic unsaved work",
    );
    trees.push(git(repo, "rev-parse", `${current.snapshotRef}^{tree}`));
  }
  assert.equal(new Set(trees).size, 1);
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const digest = createHash("sha256");
  for (const relative of [
    "src/agents/worktrees/gc-removal.ts",
    "src/agents/worktrees/service.ts",
    "src/agents/worktrees/registry-read.kernel.ts",
    "src/agents/worktrees/registry-retirement.ts",
    "src/gateway/worktree-maintenance.ts",
  ]) {
    const original = baseline && path.join(baseline, relative);
    digest.update(
      fs.readFileSync(
        original && fs.existsSync(original) ? original : path.join(sourceRoot, relative),
      ),
    );
  }
  const report = {
    sourceDigest: digest.digest("hex"),
    baseline: baseline ?? null,
    diagnosticProfile: values.profile,
    node: process.version,
    platform: process.platform,
    filesPerWorktree: fixture.files,
    bytesPerWorktree: fixture.files * fixture.fileBytes,
    worktrees,
    sessions,
    agentDatabaseBytes,
    wallMs,
    logicalElapsedMs: wallMs + skippedWaitMs,
    skippedWaitMs,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    mainAllocatedBytes: allocatedBytes,
    admissionsMs: admissions.map((atMs) => atMs - admissions[0]!),
    removals: removals.map((removal) => ({
      id: removal.id,
      wallMs: removal.wallMs,
      atMs: removal.atMs - removals[0]!.atMs,
    })),
    snapshotTree: trees[0],
    result,
    loadBefore,
    loadAfter: os.loadavg(),
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await owner?.stop();
  await scheduler.stop();
  await drainGlobalSingletonLifecycleState();
}
