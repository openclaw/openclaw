/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-removal-snapshot-measure.ts \
 *   --output <new-owned-directory> --files 62000 --file-bytes 18432 --tracked 2388
 * Run two identical-code controls, then five serial interleaved baseline/candidate pairs.
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse pinned source overlay in every worker.
 * Each process creates a fresh native Git repository and shared-state database, provisions
 * the dependency tree through service.create, then times the real service.remove boundary.
 * Setup, verification and worker drainage are outside the timed window. No remote/model,
 * session transport, competing writer or unrelated agent database is simulated.
 * Acceptance at the default size: snapshot <10s and >90% faster, zero dependency
 * chunk writes and one .env chunk; preserve tracked edits/nonignored user files,
 * improve CPU/allocation without a >20% removal regression. Filesystem caches are
 * warm after creation; every run has fresh process/database state, with workers
 * warmed by creation. This does not claim a cold-storage latency bound.
 * Each Git subprocess and registry mutation gets an inclusive host-boundary timing; these
 * include IPC/admission and are not native SQL-only times. Main allocation is exact V8;
 * process CPU includes workers but excludes Git children. Use --cpu-prof for CPU profiles.
 * --profile is a separate diagnostic pass: real worker CPU/allocation sampling, SQL
 * statement counts/native duration, and writer-hold intervals; exclude its timings.
 * All files are synthetic. The output retains the fixture, report and operation timings.
 * --mode gc-overlimit prepares a real projection, adds 32 synthetic 32-MiB files,
 * and measures first rejection plus --passes 5 later idle sweeps. It retains all
 * files and the rejected checkpoint. --archive-overlimit first accepts the ignored
 * .artifacts/ files in two 512-MiB checkpoints, so only the archive overlay exceeds
 * the cap. --mode gc-legacy-build accepts 39,000 dist/worker files plus 1,000
 * .cache/openclaw-bun files before adding Git ignores, then times cleanup of
 * that historical baseline. --prepare-only separates fixture setup from the first
 * measured reopen. With --files 22000 --file-bytes 8192, its canonical
 * checkout has about 64k files / 1.08 GB. Reopen with --reuse-fixture --report <name>
 * for fresh-process A/A controls and five interleaved A/B pairs without rebuilding
 * the 62k-file fixture. Each arm owns its own directory; never switch an arm's code.
 * GC selection advances 25 hours per sweep (persisted across reopens), beyond the
 * existing 24-hour retry backoff. Lease clocks and real timers are unchanged.
 * Acceptance: one removal attempt, durable actionable rejection, zero attempts on
 * subsequent passes/reopens, unchanged guest bytes and pending ref. Baseline is
 * allowed to retry so its failed invariant can be measured. Timing excludes setup,
 * outcome reads and verification; CPU excludes child Git. No agent DB, btrfs,
 * model, or session transport is simulated. --profile is snapshot-only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "18432" },
    tracked: { type: "string", default: "2388" },
    profile: { type: "boolean", default: false },
    mode: { type: "string", default: "snapshot" },
    "reuse-fixture": { type: "boolean", default: false },
    "archive-overlimit": { type: "boolean", default: false },
    "prepare-only": { type: "boolean", default: false },
    report: { type: "string", default: "report.json" },
    passes: { type: "string", default: "5" },
  },
});
assert(values.output, "--output must name a new task-owned directory");
const output = path.resolve(values.output);
const files = Number(values.files);
const fileBytes = Number(values["file-bytes"]);
const tracked = Number(values.tracked);
assert([files, fileBytes, tracked].every((value) => Number.isSafeInteger(value) && value > 0));
assert(tracked >= 3);
assert(["snapshot", "gc-overlimit", "gc-legacy-build"].includes(values.mode));
const gcMode = values.mode !== "snapshot";
const legacyBuild = values.mode === "gc-legacy-build";
assert(!values["reuse-fixture"] || gcMode);
assert(!values["prepare-only"] || gcMode);
assert(!values["archive-overlimit"] || values.mode === "gc-overlimit");
assert(!values.profile || values.mode === "snapshot");
if (!values["reuse-fixture"]) {
  fs.mkdirSync(output);
  for (const directory of ["home", "tmp", "state", "repo"]) {
    fs.mkdirSync(path.join(output, directory));
  }
}
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const profileEnv: Record<string, string> = values.profile
  ? {
      OPENCLAW_BENCH_RETAINED_WORKER_DIR: path.join(output, "profiles"),
      OPENCLAW_BENCH_COUNT_SQL: "1",
      OPENCLAW_BENCH_SAMPLE_CPU: "1",
      OPENCLAW_BENCH_SAMPLE_ALLOCATION: "1",
    }
  : {};
Object.assign(process.env, profileEnv);
if (baseline || values.profile) {
  await import("./worker-retained-heap-preload.js");
}
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const fingerprint = createHash("sha256");
for (const relative of [
  "src/agents/worktrees/removal.ts",
  "src/agents/worktrees/service.ts",
  "src/agents/worktrees/gc-protection.ts",
  "src/agents/worktrees/registry-retirement.ts",
  "src/agents/worktrees/snapshot-host.ts",
  "src/agents/worktrees/snapshot-inventory.ts",
  "src/agents/worktrees/provisioned-snapshot.ts",
  "src/agents/worktrees/gc-removal.ts",
  "src/gateway/worker-environments/local-workspace-checkpoint.ts",
  "src/gateway/worker-environments/local-workspace-state.ts",
  "src/gateway/worker-environments/local-workspace-manifest-scan.ts",
]) {
  const original = baseline && path.join(baseline, relative);
  fingerprint
    .update(relative)
    .update(
      fs.readFileSync(
        original && fs.existsSync(original) ? original : path.join(sourceRoot, relative),
      ),
    );
}
const sourceDigest = fingerprint.digest("hex");
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
    ...profileEnv,
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
type Timing = {
  kind: string;
  operation: string;
  elapsedMs: number;
  bytes?: number;
  mainThreadCpuMs?: number;
  processCpuMs?: number;
  mainThreadAllocatedBytes?: number;
};
const timings: Timing[] = [];
let measuring = false;
const key = Symbol.for("openclaw.perf.worktree-removal-snapshot");
const gcClockKey = Symbol.for("openclaw.perf.worktree-overlimit-gc-now");
let gcNow = Date.now();
Object.defineProperty(globalThis, gcClockKey, { configurable: true, value: () => gcNow });
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: (kind: string, args: unknown[]) => {
    const started = performance.now();
    const snapshotCpu = kind === "snapshot" ? process.cpuUsage() : undefined;
    const snapshotMainCpu = kind === "snapshot" ? process.threadCpuUsage() : undefined;
    const snapshotAllocation =
      kind === "snapshot" ? getHeapStatistics().total_allocated_bytes : undefined;
    let operation = kind;
    let bytes: number | undefined;
    if (kind === "git") {
      const argv = args[1] as string[];
      let index = 0;
      while (argv[index]?.startsWith("-")) {
        index += argv[index] === "-c" || argv[index] === "--git-dir" ? 2 : 1;
      }
      operation =
        argv[index] === "worktree" ? `worktree.${argv[index + 1]}` : (argv[index] ?? "unknown");
    } else if (kind === "registry") {
      const command = args[1] as {
        type: string;
        input: { value?: { kind?: string; data?: Uint8Array } };
      };
      operation = command.type + (command.input.value?.kind ? `.${command.input.value.kind}` : "");
      bytes = command.input.value?.data?.byteLength;
    }
    return () => {
      if (measuring) {
        const cpu = snapshotCpu && process.cpuUsage(snapshotCpu);
        const mainCpu = snapshotMainCpu && process.threadCpuUsage(snapshotMainCpu);
        timings.push({
          kind,
          operation,
          elapsedMs: performance.now() - started,
          ...(bytes === undefined ? {} : { bytes }),
          ...(cpu && mainCpu && snapshotAllocation !== undefined
            ? {
                processCpuMs: (cpu.user + cpu.system) / 1000,
                mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
                mainThreadAllocatedBytes:
                  getHeapStatistics().total_allocated_bytes - snapshotAllocation,
              }
            : {}),
        });
      }
    };
  },
});
const hooks = registerHooks({
  load(url, context, next) {
    if (gcMode && url.endsWith("/src/agents/worktrees/service.ts")) {
      const relative = path.relative(sourceRoot, fileURLToPath(url));
      const original = baseline && path.join(baseline, relative);
      let source = fs.readFileSync(
        original && fs.existsSync(original) ? original : new URL(url),
        "utf8",
      );
      const gcStart = source.indexOf("  async gc(");
      const clock = source.indexOf("const now = Date.now();", gcStart);
      assert(gcStart >= 0 && clock > gcStart, "Missing GC selection clock");
      source =
        source.slice(0, clock) +
        source
          .slice(clock)
          .replace(
            "const now = Date.now();",
            'const now = globalThis[Symbol.for("openclaw.perf.worktree-overlimit-gc-now")]();',
          );
      return { format: "module-typescript", shortCircuit: true, source };
    }
    const names = url.endsWith("/src/infra/git-exec.ts")
      ? ["executeGitCommand", "executeGitCommandBytes", "executeGitCommandBuffered"]
      : url.endsWith("/src/agents/worktrees/registry-run-end.ts")
        ? ["runWorktreeRunEndCommand"]
        : url.endsWith("/src/agents/worktrees/snapshot-host.ts")
          ? ["captureManagedWorktreeSnapshot"]
          : url.endsWith("/src/gateway/worker-environments/workspace-manifest-worker.ts")
            ? ["prepareWorkspaceStageInput"]
            : [];
    if (!names.length) {
      return next(url, context);
    }
    const relative = path.relative(sourceRoot, fileURLToPath(url));
    const original = baseline && path.join(baseline, relative);
    let source = fs.readFileSync(
      original && fs.existsSync(original) ? original : new URL(url),
      "utf8",
    );
    for (const name of names) {
      const pattern = new RegExp(`export (async )?function ${name}\\(`);
      assert(pattern.test(source), `Missing instrumentation boundary: ${name}`);
      source = source.replace(pattern, `$1function ${name}Measured(`);
      const kind = name.startsWith("executeGit")
        ? "git"
        : name.startsWith("runWorktree")
          ? "registry"
          : name === "prepareWorkspaceStageInput"
            ? "staging"
            : "snapshot";
      source += `\nexport async function ${name}(...args: Parameters<typeof ${name}Measured>) {
        const finish = globalThis[Symbol.for("openclaw.perf.worktree-removal-snapshot")](${JSON.stringify(kind)}, args);
        try { return await ${name}Measured(...args); } finally { finish(); }
      }\n`;
    }
    return { format: "module-typescript", shortCircuit: true, source };
  },
});
const repo = path.join(output, "repo");
const git = (args: string[], cwd = repo) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const dependencyDirectory = (index: number) => {
  const name = `package-${Math.floor(index / 100)}`;
  return path.join("node_modules", ".pnpm", `${name}@1.0.0`, "node_modules", name, "lib");
};
if (!values["reuse-fixture"]) {
  git(["init", "-b", "main", "--template="]);
  git(["config", "user.name", "Synthetic Benchmark"]);
  git(["config", "user.email", "benchmark@example.invalid"]);
  git(["config", "maintenance.auto", "false"]);
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    "node_modules/\n.env.local\n" + (values["archive-overlimit"] ? ".artifacts/\n" : ""),
  );
  fs.writeFileSync(path.join(repo, ".worktreeinclude"), "node_modules/\n.env.local\n");
  fs.mkdirSync(path.join(repo, "src"));
  for (let index = 0; index < tracked - 2; index++) {
    fs.writeFileSync(
      path.join(repo, "src", `${index}.ts`),
      `export const value${index} = ${index};\n`,
    );
  }
  git(["add", "."]);
  git(["commit", "-m", "synthetic source"]);
  const dependency = Buffer.alloc(fileBytes, 97);

  for (let index = 0; index < files; index++) {
    const directory = path.join(repo, dependencyDirectory(index));
    if (index % 100 === 0) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(directory, `${index}.js`), dependency);
  }
  fs.writeFileSync(path.join(repo, ".env.local"), "SYNTHETIC_SETTING=initial\n");
}
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config, config);
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { getRegistryWorktreeProvisionedState } =
  await import("../../src/agents/worktrees/registry.js");
const { getRegistryWorktreeProvisionedChunk } =
  await import("../../src/agents/worktrees/registry-read.js");
const service = new ManagedWorktreeService({ env: process.env, getConfig: () => config });
const profiledWorkers: string[] = [];
async function profileWorkers(operation: "start" | "stop") {
  if (!values.profile) {
    return;
  }
  const directory = path.join(output, "profiles");
  if (operation === "start") {
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".ready.json"))) {
      const ready = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as {
        script: string;
      };
      if (
        /^(git-operation|sqlite-store)\.worker\./u.test(ready.script) ||
        ready.script.startsWith("storage-worker.")
      ) {
        profiledWorkers.push(path.join(directory, name.slice(0, -".ready.json".length)));
      }
    }
    assert(profiledWorkers.length > 0, "No real Git/SQLite workers available for profiling");
  }
  for (const prefix of profiledWorkers) {
    const command = `${prefix}.command.json`;
    const id = `removal-${operation}`;
    fs.writeFileSync(`${command}.tmp`, JSON.stringify({ id, operation }));
    fs.renameSync(`${command}.tmp`, command);
    const reply = `${prefix}.${id}.json`;
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(reply)) {
      assert(Date.now() < deadline, `Timed out profiling ${path.basename(prefix)}`);
      await delay(25);
    }
    assert.equal(JSON.parse(fs.readFileSync(reply, "utf8")).ok, true);
  }
}
async function measureOverlimitGc() {
  const { updateRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  const { withLocalWorkspaceProjection } =
    await import("../../src/gateway/worker-environments/local-workspace-projection.js");
  const { withLocalWorkspaceStore } =
    await import("../../src/gateway/worker-environments/local-workspace-store.js");
  const fixturePath = path.join(output, "gc-fixture.json");
  const reportPath = path.resolve(output, values.report);
  assert(!fs.existsSync(reportPath), "Report must be a new file");
  const passes = Number(values.passes);
  assert(Number.isSafeInteger(passes) && passes > 0);
  type Fixture = {
    id: string;
    projection: string;
    files: number;
    fileBytes: number;
    sweeps: number;
    archiveOverlimit?: boolean;
    legacyBuild?: boolean;
  };
  let fixture: Fixture;
  const bytes = legacyBuild ? 22 * 1024 : 32 * 1024 * 1024;
  const payloadCount = legacyBuild ? 40_000 : 32;
  const payloadPath = (index: number) =>
    legacyBuild
      ? index < 39_000
        ? `dist/worker-${index}.js`
        : `.cache/openclaw-bun/compiled-${index}.js`
      : path.join(values["archive-overlimit"] ? ".artifacts" : "", `oversized-${index}.bin`);
  if (values["reuse-fixture"]) {
    fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
    assert.equal(Boolean(fixture.archiveOverlimit), values["archive-overlimit"]);
    assert.equal(Boolean(fixture.legacyBuild), legacyBuild);
  } else {
    const sessionKey = "agent:main:synthetic-overlimit-gc";
    const created = await service.create({
      repoRoot: repo,
      name: "synthetic-overlimit",
      baseRef: "HEAD",
      runSetupScript: false,
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const record = (await service.listRegistryRecords()).find((entry) => entry.id === created.id);
    assert(record);
    const owner = {
      agentId: "main",
      sessionKey,
      sessionId: "synthetic-overlimit-gc",
      lifecycleRevision: null,
      worktree: record,
      env: process.env,
      assertCurrent() {},
    };
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    const contents = Buffer.alloc(bytes, 71);
    if (values["archive-overlimit"] || legacyBuild) {
      fs.mkdirSync(path.join(projection, ".artifacts"), { recursive: true });
    }
    if (legacyBuild) {
      fs.mkdirSync(path.join(projection, "dist"));
      fs.mkdirSync(path.join(projection, ".cache/openclaw-bun"), { recursive: true });
      fs.writeFileSync(
        path.join(projection, ".artifacts/owner-report.md"),
        "preserved authored work\n",
      );
    }
    for (let index = 0; index < payloadCount; index++) {
      fs.writeFileSync(path.join(projection, payloadPath(index)), contents);
      if (
        (values["archive-overlimit"] || legacyBuild) &&
        (index === payloadCount / 2 - 1 || index === payloadCount - 1)
      ) {
        await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      }
    }
    if (legacyBuild) {
      // The old accepted baseline predates current Git eligibility; only cleanup recaptures it.
      const ignore =
        fs.readFileSync(path.join(record.path, ".gitignore"), "utf8") +
        "dist/\n.cache/openclaw-bun/\n.artifacts/\n";
      for (const directory of [record.path, projection]) {
        fs.writeFileSync(path.join(directory, ".gitignore"), ignore);
      }
    }
    await updateRegistryWorktree(process.env, record.id, { lastActiveAt: 0 });
    fixture = {
      id: record.id,
      projection,
      files,
      fileBytes,
      sweeps: 0,
      archiveOverlimit: values["archive-overlimit"],
      legacyBuild,
    };
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  }
  if (values["prepare-only"]) {
    return;
  }
  let removalAttempts = 0;
  const remove = service.remove.bind(service);
  service.remove = async (...args) => {
    removalAttempts++;
    return remove(...args);
  };
  const readOutcome = () =>
    withLocalWorkspaceStore({ worktreeId: fixture.id, env: process.env }, async (store) => {
      const row = store.get();
      assert(row, "GC must preserve the projection");
      return {
        pendingRef: row.pending_ref,
        rejection: row.rejectedResult,
        revision: row.revision,
        hasJournal: Boolean(row.journal_json),
      };
    });
  const before = await readOutcome();
  let pendingRef = before.pendingRef;
  const samples = [];
  for (let pass = 0; pass < passes + (values["reuse-fixture"] ? 0 : 1); pass++) {
    gcNow = Date.now() + fixture.sweeps * 25 * 60 * 60_000;
    const attemptsBefore = removalAttempts;
    const operationStart = timings.length;
    const loadBefore = os.loadavg();
    const allocation = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocation), "Use a runtime exposing exact V8 allocation counters");
    const mainCpu = process.threadCpuUsage();
    const cpu = process.cpuUsage();
    const started = performance.now();
    measuring = true;
    const outcome = await service.gc();
    measuring = false;
    const elapsedMs = performance.now() - started;
    const usedCpu = process.cpuUsage(cpu);
    const usedMainCpu = process.threadCpuUsage(mainCpu);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
    const firstCleanup = fixture.sweeps === 0;
    assert.deepEqual(outcome.removed, !baseline && legacyBuild && firstCleanup ? [fixture.id] : []);
    const retained = await readOutcome();
    if (!legacyBuild) {
      assert(retained.pendingRef, "Over-limit result reservation must be retained");
    }
    if ((!baseline || !values["archive-overlimit"]) && !legacyBuild) {
      assert(retained.rejection, "Over-limit result must be durably rejected");
      if (pendingRef) {
        assert.equal(retained.pendingRef, pendingRef);
      }
    }
    pendingRef = retained.pendingRef;
    const record = (await service.listRegistryRecords()).find((entry) => entry.id === fixture.id);
    const sample = {
      pass,
      sweep: fixture.sweeps,
      selectionNow: gcNow,
      firstRejection: firstCleanup,
      elapsedMs,
      mainThreadCpuMs: (usedMainCpu.user + usedMainCpu.system) / 1000,
      totalProcessCpuMs: (usedCpu.user + usedCpu.system) / 1000,
      mainThreadAllocatedBytes: allocatedBytes,
      removalAttempts: removalAttempts - attemptsBefore,
      stagingAttempts: timings.slice(operationStart).filter((entry) => entry.kind === "staging")
        .length,
      outcome,
      retained,
      record,
      loadBefore,
      loadAfter: os.loadavg(),
    };
    if (!baseline) {
      assert.equal(sample.removalAttempts, sample.firstRejection ? 1 : 0);
      assert.equal(sample.stagingAttempts, sample.firstRejection ? (legacyBuild ? 2 : 1) : 0);
      if (legacyBuild) {
        assert.equal(retained.rejection, undefined);
        assert(record?.removedAt, "Legacy build exclusion must let normal cleanup finish");
      }
      const visible = JSON.stringify(outcome);
      if (!legacyBuild) {
        assert(
          visible.includes(retained.pendingRef!),
          "GC outcome must expose the retained result ref",
        );
        assert(
          visible.includes(fixture.projection),
          "GC outcome must locate recoverable guest files",
        );
        assert(visible.includes("--retry-deferred"), "GC outcome must explain the recovery step");
      }
    }
    samples.push(sample);
    fixture.sweeps++;
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    console.log(JSON.stringify(sample));
  }
  for (let index = 0; index < payloadCount; index++) {
    const filename = path.join(fixture.projection, payloadPath(index));
    assert.equal(fs.statSync(filename).size, bytes);
    const fd = fs.openSync(filename, "r");
    const content = Buffer.alloc(1);
    try {
      fs.readSync(fd, content, 0, 1, bytes - 1);
      assert.equal(content[0], 71);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        sourceDigest,
        baseline: baseline ?? null,
        mode: values.mode,
        reused: values["reuse-fixture"],
        node: process.version,
        platform: process.platform,
        fixture,
        changedFiles: payloadCount,
        changedBytes: payloadCount * bytes,
        samples,
      },
      null,
      2,
    ),
  );
}

async function closeMeasurement() {
  measuring = false;
  await drainGlobalSingletonLifecycleState();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  Reflect.deleteProperty(globalThis, gcClockKey);
}

if (gcMode) {
  try {
    await measureOverlimitGc();
  } finally {
    await closeMeasurement();
  }
  process.exit(0);
}

try {
  const created = await service.create({
    repoRoot: repo,
    name: "synthetic-removal",
    baseRef: "HEAD",
    runSetupScript: false,
  });
  assert.equal(
    fs.statSync(path.join(created.path, dependencyDirectory(files - 1), `${files - 1}.js`)).size,
    fileBytes,
  );
  fs.writeFileSync(path.join(created.path, "src/0.ts"), "export const userEdit = true;\n");
  fs.writeFileSync(path.join(created.path, "user-notes.txt"), "synthetic unsaved user work\n");
  fs.writeFileSync(path.join(created.path, ".env.local"), "SYNTHETIC_SETTING=edited\n");
  if (values.profile) {
    const { runGitWorkerOperation } = await import("../../src/infra/git-worker.js");
    // Creation and maintenance have separate workers; admit the measured owner first.
    await runGitWorkerOperation({
      type: "worktree.cleanup-inspection",
      input: { kind: "provisioned", checkoutPath: created.path, provisionedPaths: [] },
    });
  }
  await profileWorkers("start");
  const loadBefore = os.loadavg();
  const memoryBefore = process.memoryUsage();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const gc = new GCProfiler();
  loop.enable();
  gc.start();
  const allocation = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocation), "Use a runtime exposing exact V8 allocation counters");
  const mainCpu = process.threadCpuUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  measuring = true;
  const removed = await service.remove({
    id: created.id,
    reason: "synthetic performance fixture",
  });
  measuring = false;
  const elapsedMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  const usedMainCpu = process.threadCpuUsage(mainCpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
  const gcStats = gc.stop()?.statistics ?? [];
  loop.disable();
  await profileWorkers("stop");
  assert(removed.removed && removed.snapshotRef);
  assert.equal(git(["show", `${removed.snapshotRef}:src/0.ts`]), "export const userEdit = true;");
  assert.equal(
    git(["show", `${removed.snapshotRef}:user-notes.txt`]),
    "synthetic unsaved user work",
  );
  const states = await getRegistryWorktreeProvisionedState(process.env, created.id);
  assert(states?.some((state) => state.path === ".env.local" && state.chunks === 1));
  assert.equal(
    Buffer.from(
      (await getRegistryWorktreeProvisionedChunk(process.env, {
        worktreeId: created.id,
        path: ".env.local",
        chunkIndex: 0,
      }))!,
    ).toString(),
    "SYNTHETIC_SETTING=edited\n",
  );
  const summary: Record<
    string,
    { count: number; elapsedMs: number; maxMs: number; bytes: number }
  > = {};
  for (const timing of timings) {
    const row = (summary[timing.operation] ??= { count: 0, elapsedMs: 0, maxMs: 0, bytes: 0 });
    row.count++;
    row.elapsedMs += timing.elapsedMs;
    row.maxMs = Math.max(row.maxMs, timing.elapsedMs);
    row.bytes += timing.bytes ?? 0;
  }
  const result = {
    sourceDigest,
    baseline: baseline ?? null,
    diagnosticProfile: values.profile,
    node: process.version,
    platform: process.platform,
    tracked,
    files,
    fileBytes,
    provisionedBytes: files * fileBytes,
    elapsedMs,
    snapshotMs: summary.snapshot?.elapsedMs,
    snapshot: timings.find((timing) => timing.kind === "snapshot"),
    totalProcessCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    mainThreadCpuMs: (usedMainCpu.user + usedMainCpu.system) / 1000,
    mainThreadAllocatedBytes: allocatedBytes,
    gc: {
      count: gcStats.length,
      totalMs: gcStats.reduce((sum, entry) => sum + entry.cost / 1000, 0),
      maxMs: Math.max(0, ...gcStats.map((entry) => entry.cost / 1000)),
    },
    eventLoopMaxMs: loop.max / 1e6,
    persistedProvisionedFiles: states?.length,
    snapshotTree: git(["rev-parse", `${removed.snapshotRef}^{tree}`]),
    persistedDependencyFiles: states?.filter((state) => state.path.startsWith("node_modules/"))
      .length,
    summary,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    loadBefore,
    loadAfter: os.loadavg(),
  };
  fs.writeFileSync(
    path.join(output, "operations.jsonl"),
    timings.map((timing) => JSON.stringify(timing)).join("\n") + "\n",
  );
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.persistedDependencyFiles, baseline ? files : 0);
  assert.equal(result.persistedProvisionedFiles, baseline ? files + 1 : 1);
  assert.equal(
    summary["worktrees.writeProvisionedSnapshot.chunk"]?.count,
    baseline ? files + 1 : 1,
  );
  assert.equal(
    summary["worktrees.writeProvisionedSnapshot.chunk"]?.bytes,
    (baseline ? files * fileBytes : 0) + Buffer.byteLength("SYNTHETIC_SETTING=edited\n"),
  );
  if (!baseline && !values.profile) {
    assert(
      result.snapshotMs !== undefined && result.snapshotMs < 10_000,
      "Candidate snapshot exceeded the 10s acceptance bound",
    );
  }
} finally {
  await closeMeasurement();
}
