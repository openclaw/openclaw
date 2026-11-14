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
 * CPU (workers included, broker/Git children excluded). Setup/verification/drainage are untimed.
 * Only scheduled waits are virtualized: filesystem, SQLite, snapshots and removal are
 * real. Report actual owner wall time separately from the logical maintenance timeline.
 * Acceptance: <=1 candidate admission/minute, identical complete snapshot contents,
 * and no >20% per-removal CPU/allocation regression beyond A/A spread. This fixture
 * does not reproduce Linux btrfs backrefs, physical cache misses, chat latency or a
 * large transcript database: this owner resolves session metadata for the selected
 * worktrees, not transcript bodies. The fixture has 5,000 real session metadata rows.
 * Checkouts hardlink immutable synthetic files to limit disk use;
 * the one edited file is unlinked before writing. Source setup is excluded from timing.
 *
 * Reclaim-starvation mode: --scratch-clones 806 --observe-ms 30000 --psi-trace.
 * Uses real timers and a fixed observation window; clone-shaped expired scratch splits
 * the source's file count across candidates. Linux-only --psi-trace injects 1–5% full
 * pressure with 30% spikes into the production probe's /proc input; btrfs commit counters
 * stay real. kernelSamples retain uninjected host PSI. Run on btrfs with a separate
 * synthetic background IO workload to measure deletion impact; trace admission alone
 * is not a physical pressure experiment. Acceptance: baseline near-zero scratch progress,
 * candidate positive progress, no commit/loop latency regression beyond A/A spread.
 * PSI runs flush setup writes, settle for 30 seconds, then commit a small marker before
 * timing. Report both flush durations; bulk fixture writeback is not cleanup IO.
 * Warm the removal runtime's imports before timing so source-mode compilation is not
 * mistaken for steady-state Gateway latency. Cold-process figures remain separate.
 * Restart-order mode: --scratch-order --scratch-clones 6. Each old clone contains
 * the full source file count, alongside 250 old scratch files; the newest checkout
 * contains 256 fresh entries. Measures through scratch completion at GC entry with
 * virtualized pacing and hardlinked immutable fixture files, not storage throughput.
 * Recurring minute-scale maintenance is parked in this scratch-only measurement.
 * Baseline overlays the custody owner. --reuse-scratch-order reuses only a completed
 * synthetic fixture between serial arms, rebuilding removed clones outside timing.
 * Acceptance: 0 -> 6 clone removals, 256 total entries, fresh scratch unchanged.
 * Binding-starvation mode: --scratch-binding missing|stale with --scratch-order.
 * Keep one real execution live without a session key, or continuously publish
 * binding invalidations for the newest (fresh) checkout. Acceptance: the parent
 * reclaims zero, the candidate completes its 256-entry scratch budget while
 * preserving the live/fresh checkout. Report CPU/allocation and loop tails for
 * the complete phase; zero-work failures are not per-removal performance controls.
 * Worker offload comparisons include worker startup in the whole-pass measurements.
 * Overlay scratch-cleanup.ts for the baseline: both arms must remove all six
 * clones, and main CPU/allocation must fall without worsening loop tails.
 * Reuse the prior physical pressure qualification; do not interpret accelerated
 * scheduler time or these clone-shaped trees as Git or btrfs throughput evidence.
 * Seed a large isolated DB with generateTeamShapeFixture from team-shape-fixture.ts,
 * using session keys agent:main:synthetic-0 through agent:main:synthetic-4999, then
 * reuse its closed agent database with --agent-db-fixture for every measured arm.
 * The transcript owner compresses synthetic content; report physical DB bytes, not
 * the requested logical size. COPYFILE_EXCL refuses replacing an already opened DB.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
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
    "scratch-clones": { type: "string", default: "0" },
    "scratch-order": { type: "boolean", default: false },
    "scratch-binding": { type: "string" },
    "reuse-scratch-order": { type: "boolean", default: false },
    "observe-ms": { type: "string", default: "0" },
    "psi-trace": { type: "boolean", default: false },
    "agent-db-fixture": { type: "string" },
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
const scratchClones = Number(values["scratch-clones"]);
const scratchOrder = values["scratch-order"];
const observeMs = Number(values["observe-ms"]);
assert(Number.isSafeInteger(worktrees) && worktrees >= 2);
assert(Number.isSafeInteger(scratchClones) && scratchClones >= 0);
assert(Number.isSafeInteger(observeMs) && observeMs >= 0);
const scratchBinding = values["scratch-binding"];
assert(!scratchBinding || (scratchOrder && ["missing", "stale"].includes(scratchBinding)));
const reused = values["reuse-scratch-order"]
  ? JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"))
  : undefined;
if (reused) {
  assert(scratchOrder && reused.scratchOrder && reused.worktrees === worktrees);
  assert.equal(reused.scratchClones, scratchClones);
  assert(
    reused.scratchRemaining === 0 ||
      (reused.scratchRemaining === scratchClones &&
        (reused.result.scratch?.filesRemoved ?? 0) === 0),
  );
}
fs.mkdirSync(output, { recursive: Boolean(reused) });
for (const directory of ["home", "tmp", "state"]) {
  fs.mkdirSync(path.join(output, directory), { recursive: Boolean(reused) });
}
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
const configPath = path.join(output, "openclaw.json");
// os.tmpdir also consults the native environment, before the isolated JS env below.
process.env.TMPDIR = path.join(output, "tmp");
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
const {
  runOpenClawAgentWriteTransaction,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} = await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { startWorktreeMaintenance } = await import("../../src/gateway/worktree-maintenance.js");
const { getSpawnBroker, runWithSpawnBroker } =
  await import("../../src/process/spawn-broker/context.js");
const { createSpawnBrokerHost } = await import("../../src/process/spawn-broker/host.js");
const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../../src/infra/agent-run-registry.js");
const { sessionChanges } = await import("../../src/sessions/session-row-changes.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  files: number;
  fileBytes: number;
  snapshot: string;
  paths: string[];
};
const repo = path.join(output, "repo");
if (!reused) {
  git(output, "clone", "--quiet", "--shared", "--no-checkout", source, repo);
}
git(repo, "config", "maintenance.auto", "false");
const { fingerprint } = await managedWorktrees.resolveRepositoryIdentity(repo);
const records: ManagedWorktreeRecord[] = reused
  ? (await managedWorktrees.listRegistryRecords()).toSorted((a, b) => a.createdAt - b.createdAt)
  : [];
if (reused) {
  assert.equal(reused.filesPerWorktree, fixture.files);
  assert.equal(reused.bytesPerWorktree, fixture.files * fixture.fileBytes);
  assert.equal(records.length, worktrees);
  assert(records.every((record) => record.removedAt === undefined));
}
for (let index = records.length; index < worktrees; index++) {
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
    createdAt: scratchOrder ? index + 1 : 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, record, { provisionedPaths: [] });
  records.push(record);
  console.error(JSON.stringify({ prepared: records.length, worktrees, files: fixture.files }));
}
// Put scratch last so the old owner must traverse the ordinary removal backlog first.
const scratchRoot = path.join(
  records[scratchOrder ? 0 : records.length - 1]!.path,
  ".openclaw/tmp",
);
const expired = new Date(Date.now() - 25 * 60 * 60_000);
for (let index = 0; index < scratchClones; index++) {
  const clone = path.join(scratchRoot, `clone-${index}`);
  if (reused?.scratchRemaining === scratchClones) {
    continue;
  }
  fs.mkdirSync(path.join(clone, ".git/objects"), { recursive: true });
  fs.writeFileSync(path.join(clone, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.utimesSync(path.join(clone, ".git/HEAD"), expired, expired);
  for (
    let entry = scratchOrder ? 0 : index;
    entry < fixture.paths.length;
    entry += scratchOrder ? 1 : scratchClones
  ) {
    const file = path.join(clone, `${entry}.ts`);
    if (scratchOrder) {
      fs.linkSync(path.join(source, fixture.paths[entry]!), file);
    } else {
      fs.copyFileSync(
        path.join(source, fixture.paths[entry]!),
        file,
        fs.constants.COPYFILE_FICLONE,
      );
    }
    if (!scratchOrder || index === 0) {
      fs.utimesSync(file, expired, expired);
    }
  }
  fs.utimesSync(path.join(clone, ".git/objects"), expired, expired);
}
if (scratchOrder) {
  assert(scratchClones > 0 && scratchClones < 256 && !observeMs);
  const freshRoot = path.join(records.at(-1)!.path, ".openclaw/tmp");
  fs.mkdirSync(freshRoot, { recursive: true });
  for (let index = 0; index < 256; index++) {
    fs.writeFileSync(path.join(freshRoot, `fresh-${index}`), "fresh scratch");
    if (index < 256 - scratchClones) {
      const file = path.join(scratchRoot, `expired-${index}`);
      fs.writeFileSync(file, "expired scratch");
      fs.utimesSync(file, expired, expired);
    }
  }
}
const sessions = 5_000;
if (values["agent-db-fixture"] && !reused) {
  const destination = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(
    values["agent-db-fixture"],
    destination,
    fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL,
  );
}
for (let offset = 0; offset < sessions; offset += 100) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = offset; index < Math.min(offset + 100, sessions); index++) {
        const record = records[index];
        writeSessionEntry(database, `agent:main:synthetic-${index}`, {
          // Preserve the canonical fixture's current transcript window.
          sessionId: `team-shape-session-${index}`,
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
const preparationFlushMs: number[] = [];
const pressureFiles = [1, 2, 3, 4, 5, 30].map((full) => {
  const file = path.join(output, `synthetic-psi-${full}`);
  if (values["psi-trace"]) {
    fs.writeFileSync(
      file,
      `some avg10=${full + 10} avg60=20 total=0\nfull avg10=${full} avg60=3 total=0\n`,
    );
  }
  return file;
});
if (values["psi-trace"]) {
  assert.equal(process.platform, "linux", "PSI trace requires Linux; no platform spoofing");
  for (let flush = 0; flush < 2; flush++) {
    if (flush) {
      await delay(30_000);
      fs.writeFileSync(path.join(output, "setup-complete"), "synthetic preparation complete\n");
    }
    const started = performance.now();
    execFileSync("sync", ["-f", output]);
    preparationFlushMs.push(performance.now() - started);
  }
}
let skippedWaitMs = 0;
const now = () => Date.now() + skippedWaitMs;
const scheduler = new GatewayScheduler({
  clock: {
    now,
    monotonicNow: () => performance.now() + skippedWaitMs,
    arm: (run, delayMs) => {
      if (observeMs) {
        const timer = setTimeout(() => void run(), delayMs);
        return () => clearTimeout(timer);
      }
      // Park the unrelated hourly recurrence; only cleanup continuation timers advance.
      if (delayMs > 10 * 60_000 || (scratchOrder && delayMs >= 60_000)) {
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
let scratchCompleted: (() => void) | undefined;
const gc = managedWorktrees.gc.bind(managedWorktrees);
managedWorktrees.gc = async (params) => {
  scratchCompleted?.();
  assert.equal(getSpawnBroker(), broker, "Maintenance must retain the Gateway spawn broker");
  if (params?.beforeRemoval) {
    const beforeRemoval = params.beforeRemoval;
    params.beforeRemoval = async (record) => {
      await beforeRemoval(record);
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
const maintenanceErrors: string[] = [];
const kernelSamples: Array<{ atMs: number; psi: string; commits: string[] }> = [];
let pressureIndex = 0;
const open = fsPromises.open;
let pressureProbeReads = 0;
if (values["psi-trace"]) {
  fsPromises.open = (file, flags, mode) => {
    if (file === "/proc/pressure/io") {
      pressureProbeReads++;
      return open(pressureFiles[pressureIndex]!, flags, mode);
    }
    return open(file, flags, mode);
  };
}
const sampleKernel = () => {
  const tick = kernelSamples.length;
  pressureIndex = tick % 7 === 6 ? 5 : tick % 5;
  kernelSamples.push({
    atMs: performance.now(),
    psi: fs.existsSync("/proc/pressure/io") ? fs.readFileSync("/proc/pressure/io", "utf8") : "",
    commits: fs.existsSync("/sys/fs/btrfs")
      ? fs.readdirSync("/sys/fs/btrfs").flatMap((id) => {
          const file = `/sys/fs/btrfs/${id}/commit_stats`;
          return fs.existsSync(file) ? [fs.readFileSync(file, "utf8")] : [];
        })
      : [],
  });
};
let kernelTimer: ReturnType<typeof setInterval> | undefined;
const loop = monitorEventLoopDelay({ resolution: 10 });
let owner: ReturnType<typeof startWorktreeMaintenance> | undefined;
let observationTimer: ReturnType<typeof setTimeout> | undefined;
const broker = process.platform === "linux" ? createSpawnBrokerHost() : undefined;
let bindingTimer: ReturnType<typeof setInterval> | undefined;
let bindingPublications = 0;
const bindingKey = records.at(-1)!.ownerId!;
const bindingClaim = scratchBinding
  ? claimAgentRunContext(
      "synthetic-scratch-binding",
      {
        registeredAt: Date.now(),
        ...(scratchBinding === "stale" ? { sessionKey: bindingKey } : {}),
      },
      { trackOwner: true },
    )
  : undefined;
try {
  await broker?.ready();
  const runtimeImportStarted = performance.now();
  await runWithSpawnBroker(
    broker,
    () => import("../../src/gateway/worker-environments/local-workspace-projection.js"),
  );
  const runtimeImportWarmupMs = performance.now() - runtimeImportStarted;
  global.gc();
  if (values.profile) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  sampleKernel();
  kernelTimer = setInterval(sampleKernel, 1_000);
  loop.enable();
  const allocationBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocationBefore), "Runtime must expose exact V8 allocation counters");
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const mainCpuBefore = process.threadCpuUsage();
  const started = performance.now();
  if (scratchBinding === "stale") {
    bindingTimer = setInterval(() => {
      bindingPublications++;
      sessionChanges.emit({ sessionKey: bindingKey, scope: "session-entry" });
    }, 1);
  }
  const result = await runWithSpawnBroker(
    broker,
    () =>
      new Promise<ManagedWorktreeGcResult>((resolve, reject) => {
        owner = startWorktreeMaintenance({
          scheduler,
          getRuntimeConfig: () => config,
          onComplete: (completed) => {
            if (!observeMs) {
              resolve(completed);
            }
          },
          onError: (message) => {
            maintenanceErrors.push(message);
            if (
              !observeMs &&
              !(
                scratchBinding === "missing" &&
                message.includes("a live run has no checkout binding yet")
              )
            ) {
              reject(new Error(message));
            }
          },
        });
        const receipt = owner.request();
        if (scratchOrder) {
          scratchCompleted = () => resolve(owner!.request({ jobId: receipt.jobId }));
        }
        if (observeMs) {
          observationTimer = setTimeout(
            () => resolve(owner!.request({ jobId: receipt.jobId })),
            observeMs,
          );
        }
      }),
  );
  const wallMs = performance.now() - started;
  clearInterval(bindingTimer);
  const processCpu = process.cpuUsage(cpuBefore);
  const mainCpu = process.threadCpuUsage(mainCpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
  loop.disable();
  clearInterval(kernelTimer);
  if (values.profile) {
    fs.writeFileSync(
      path.join(output, "cpu.cpuprofile"),
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
    fs.writeFileSync(
      path.join(output, "allocation.heapprofile"),
      JSON.stringify((await inspector.post("HeapProfiler.stopSampling")).profile),
    );
    inspector.disconnect();
  }
  if (!observeMs && !scratchOrder) {
    assert.equal(removals.length, worktrees);
  }
  if (scratchOrder) {
    await owner?.stop();
    const freshRoot = path.join(records.at(-1)!.path, ".openclaw/tmp");
    assert.equal(fs.readdirSync(freshRoot).length, 256);
    for (const name of fs.readdirSync(freshRoot)) {
      assert.equal(fs.readFileSync(path.join(freshRoot, name), "utf8"), "fresh scratch");
    }
  }
  const archived = new Map(
    (await managedWorktrees.listRegistryRecords()).map((record) => [record.id, record]),
  );
  const trees: string[] = [];
  for (const record of observeMs || scratchOrder ? [] : records) {
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
  if (!observeMs && !scratchOrder) {
    assert.equal(new Set(trees).size, 1);
  }
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const digest = createHash("sha256");
  for (const relative of [
    "src/agents/worktrees/gc-removal.ts",
    "src/agents/worktrees/service.ts",
    "src/agents/worktrees/registry-read.kernel.ts",
    "src/agents/worktrees/registry-retirement.ts",
    "src/gateway/worktree-maintenance.ts",
    "src/gateway/scratch-maintenance-custody.ts",
    "src/sessions/session-controller.queries.ts",
    "src/infra/host-io-pressure.ts",
    "src/infra/scratch-cleanup.ts",
    "src/infra/scratch-cleanup-tree.ts",
    "src/infra/fs-safe-copy.worker.ts",
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
    spawnBroker: Boolean(broker),
    runtimeImportWarmupMs,
    filesPerWorktree: fixture.files,
    bytesPerWorktree: fixture.files * fixture.fileBytes,
    worktrees,
    sessions,
    agentDatabaseBytes,
    preparationFlushMs,
    agentDatabasePath: agentDatabase.path,
    scratchClones,
    scratchOrder,
    scratchBinding,
    bindingPublications,
    scratchFilesPerClone: scratchOrder ? fixture.files : fixture.files / scratchClones,
    freshScratchRemaining: scratchOrder
      ? fs.readdirSync(path.join(records.at(-1)!.path, ".openclaw/tmp")).length
      : undefined,
    scratchRemaining:
      scratchClones && fs.existsSync(scratchRoot)
        ? fs
            .readdirSync(scratchRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory()).length
        : 0,
    injectedPsiTrace: values["psi-trace"],
    pressureProbeReads,
    maintenanceErrors,
    kernelSamples,
    eventLoopP99Ms: loop.percentile(99) / 1e6,
    eventLoopMaxMs: loop.max / 1e6,
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
  clearInterval(bindingTimer);
  releaseAgentRunContext("synthetic-scratch-binding", bindingClaim);
  clearTimeout(observationTimer);
  clearInterval(kernelTimer);
  loop.disable();
  fsPromises.open = open;
  try {
    await owner?.stop();
    await scheduler.stop();
    await drainGlobalSingletonLifecycleState();
  } finally {
    await broker?.close();
  }
}
