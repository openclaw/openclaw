import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedProcessGroup, runManagedCommand } from "./managed-child-process.mts";
import {
  inventoryPreparedWorkload,
  preparedInventoryDelta,
  type PreparedEntry,
} from "./prepared-workload-inventory.mts";
import {
  analyzeBenchmark,
  analyzeNodeCacheBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertExactSha,
  assertInventoryAvailable,
  buildBenchmarkSchedule,
  buildNodeCacheSchedule,
  parseVitestExecutionReport,
  sha256,
  writeJsonAtomic,
  withTerminalManifest,
  type BenchmarkExecutionSummary,
  type BenchmarkLane,
  type BenchmarkManifest,
  type BenchmarkRunPlan,
  type BenchmarkRunRecord,
  type BenchmarkSide,
  type PackageManagerIdentity,
  type NodeCacheManifest,
  type NodeCacheMeasurement,
  type NodeCacheTreatment,
} from "./vitest-pair-benchmark-contract.mts";

const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const VITEST_PAIR_HARNESS_DEADLINE_MS = 165 * 60 * 1000;

type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deadline?: VitestPairDeadline;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RunCommandResult = {
  exitCode: number;
  durationMs: number;
};

type BenchmarkContext = {
  baselineDir: string;
  baselineSha: string;
  candidateDir: string;
  candidateSha: string;
  manifest: BenchmarkManifest;
  outputDir: string;
  pnpmBin: string;
  scratchDir: string;
};

export type VitestPairDeadline = {
  deadlineAt: number;
  signal: AbortSignal;
  throwIfExpired: () => void;
};

function deadlineError(timeoutMs: number): Error {
  return Object.assign(
    new Error(`Vitest pair aggregate deadline exceeded after ${String(timeoutMs)}ms`),
    { code: "ETIMEDOUT" },
  );
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function withVitestPairDeadline<T>(
  task: (deadline: VitestPairDeadline) => Promise<T>,
  timeoutMs = VITEST_PAIR_HARNESS_DEADLINE_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Vitest pair aggregate deadline must be a positive integer");
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(deadlineError(timeoutMs));
    }
  };
  const timer = setTimeout(expire, timeoutMs);
  const deadline: VitestPairDeadline = {
    deadlineAt,
    signal: controller.signal,
    throwIfExpired() {
      if (Date.now() >= deadlineAt) {
        expire();
      }
      controller.signal.throwIfAborted();
    },
  };
  try {
    const result = await task(deadline);
    deadline.throwIfExpired();
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw normalizeError(controller.signal.reason);
    }
    throw normalizeError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function runOwnedCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const signal = options.deadline?.signal ?? options.signal;
  options.deadline?.throwIfExpired();
  signal?.throwIfAborted();
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "wx", 0o600);
  let childPid: number | null = null;
  const started = process.hrtime.bigint();
  try {
    options.deadline?.throwIfExpired();
    const exitCode = await runManagedCommand({
      bin: options.bin,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", logFd, logFd],
      timeoutMs: options.timeoutMs ?? CHILD_TIMEOUT_MS,
      timeoutKillGraceMs: 2_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal,
      abortKillGraceMs: 2_000,
      onReady(child) {
        childPid = child.pid ?? null;
      },
    });
    if (
      childPid &&
      inspectManagedProcessGroup(
        { pid: childPid, exitCode, signalCode: null },
        { errorPolicy: "indeterminate" },
      ) !== "dead"
    ) {
      throw new Error(`managed command process group ${String(childPid)} did not quiesce`);
    }
    return {
      exitCode,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  } finally {
    closeSync(logFd);
  }
}

function parseGnuTime(file: string) {
  const text = readFileSync(file, "utf8");
  const readSeconds = (label: string) => {
    const match = new RegExp(`^\\s*${label}:\\s*([0-9.]+)\\s*$`, "mu").exec(text);
    if (!match) {
      throw new Error(`GNU time output is missing ${label}`);
    }
    return Number.parseFloat(match[1]!) * 1000;
  };
  return {
    userCpuMs: readSeconds("User time \\(seconds\\)"),
    systemCpuMs: readSeconds("System time \\(seconds\\)"),
  };
}

export function resolvePackageManagerIdentity(
  pnpmBin: string,
  isolationRoot: string,
  ambientEnv: NodeJS.ProcessEnv = process.env,
  deadline?: VitestPairDeadline,
): PackageManagerIdentity {
  deadline?.throwIfExpired();
  const resolvedExecutable = realpathSync(pnpmBin);
  const probeCache = path.join(isolationRoot, "cache");
  const probeHome = path.join(isolationRoot, "home");
  const env = buildBenchmarkCommandEnv(
    probeHome,
    probeCache,
    {
      executable: pnpmBin,
      resolvedExecutable,
      version: "unresolved",
    },
    ambientEnv,
  );
  return {
    executable: pnpmBin,
    resolvedExecutable,
    version: commandVersion(pnpmBin, env, deadline),
  };
}

export function buildBenchmarkCommandEnv(
  home: string,
  cacheRoot: string,
  packageManager: PackageManagerIdentity,
  ambientEnv: NodeJS.ProcessEnv = process.env,
  treatment?: { kind: NodeCacheTreatment; nodeCache: string },
): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  const corepackHome = path.join(cacheRoot, "corepack");
  const pnpmHome = path.join(cacheRoot, "pnpm-home");
  const npmCache = path.join(cacheRoot, "npm-cache");
  for (const directory of [corepackHome, pnpmHome, npmCache, path.join(cacheRoot, "tmp")]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_HOME: corepackHome,
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_COMPILE_CACHE: treatment?.nodeCache ?? path.join(cacheRoot, "node-compile"),
    ...(treatment
      ? {
          COREPACK_ENABLE_NETWORK: "0",
          npm_config_offline: "true",
          pnpm_config_manage_package_manager_versions: "false",
          OPENCLAW_VITEST_RUNTIME: "node",
          OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
          OPENCLAW_VITEST_WORKER_CACHE: "0",
          ...(treatment.kind === "disabled" ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
        }
      : {}),
    PNPM_HOME: pnpmHome,
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(cacheRoot, "vitest-fs"),
    OPENCLAW_VITEST_MAX_WORKERS: "1",
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    PATH: treatment
      ? [path.dirname(packageManager.executable), path.dirname(process.execPath), ambientEnv.PATH]
          .filter(Boolean)
          .join(path.delimiter)
      : ambientEnv.PATH,
    TMPDIR: path.join(cacheRoot, "tmp"),
    npm_config_cache: npmCache,
    // Both source cuts must use the benchmark's selected pnpm, even when their
    // packageManager fields name older releases.
    pnpm_config_pm_on_fail: treatment ? "error" : "ignore",
    npm_execpath: packageManager.executable,
  };
}

function runVitestArgs(lane: BenchmarkLane, reportFile: string): string[] {
  if (!path.isAbsolute(reportFile)) {
    throw new Error("Vitest JSON report path must be absolute");
  }
  return [
    "scripts/run-vitest.mjs",
    ...(lane.config ? ["run", "--config", lane.config] : [...lane.files, "--"]),
    "--reporter=json",
    "--includeTaskLocation",
    "--outputFile",
    reportFile,
    ...(lane.config ? lane.files : []),
  ];
}

export function buildNodeCacheVitestArgs(lane: BenchmarkLane, reportFile: string): string[] {
  return [...runVitestArgs(lane, reportFile), "--no-cache", "--no-fsModuleCache"];
}

async function runBenchmarkCommand(
  context: BenchmarkContext,
  plan: BenchmarkRunPlan,
  packageManager: PackageManagerIdentity,
  deadline: VitestPairDeadline,
  expectedExecutionDigest?: string,
): Promise<BenchmarkRunRecord> {
  deadline.throwIfExpired();
  const checkout = plan.side === "baseline" ? context.baselineDir : context.candidateDir;
  const phaseRoot = path.join(context.outputDir, plan.phase);
  const runRoot = path.join(phaseRoot, plan.id);
  const warmSeed = path.join(context.scratchDir, "warm-cache", plan.side, plan.lane.id);
  const cacheRoot =
    plan.phase === "warmup"
      ? warmSeed
      : path.join(context.scratchDir, "run-cache", plan.phase, plan.id);
  mkdirSync(runRoot, { recursive: true });
  if (plan.phase === "measured") {
    if (!existsSync(warmSeed)) {
      throw new Error(`warmup cache is missing for ${plan.side}/${plan.lane.id}`);
    }
    cpSync(warmSeed, cacheRoot, { recursive: true, force: false, errorOnExist: true });
  }
  const home = path.join(cacheRoot, "home");
  mkdirSync(path.join(cacheRoot, "tmp"), { recursive: true });
  const timePath = path.join(runRoot, "gnu-time.txt");
  const logPath = path.join(runRoot, "output.log");
  const reportPath = path.resolve(runRoot, "vitest-report.json");
  const vitestArgs = runVitestArgs(plan.lane, reportPath);
  const command = ["/usr/bin/time", "-v", "-o", timePath, process.execPath, ...vitestArgs];
  const startedAt = new Date().toISOString();
  let result: RunCommandResult | undefined;
  let timing: ReturnType<typeof parseGnuTime> | undefined;
  let execution: BenchmarkExecutionSummary | null = null;
  const createRecord = (): BenchmarkRunRecord => ({
    ...plan,
    lane: plan.lane.id,
    command,
    packageManager,
    startedAt,
    durationMs: result?.durationMs ?? 0,
    userCpuMs: timing?.userCpuMs ?? 0,
    systemCpuMs: timing?.systemCpuMs ?? 0,
    execution,
    exitCode: result?.exitCode ?? null,
  });
  try {
    result = await runOwnedCommand({
      bin: command[0]!,
      args: command.slice(1),
      cwd: checkout,
      env: buildBenchmarkCommandEnv(home, cacheRoot, packageManager),
      logPath,
      deadline,
    });
    timing = parseGnuTime(timePath);
    if (result.exitCode !== 0) {
      throw new Error(`${plan.id} exited with status ${result.exitCode}`);
    }
    execution = parseVitestExecutionReport(reportPath, checkout, plan.lane);
    if (expectedExecutionDigest !== undefined) {
      assertExecutionDigest(execution, expectedExecutionDigest, plan.id);
    }
    const record = createRecord();
    writeJsonAtomic(path.join(runRoot, "record.json"), record);
    return record;
  } catch (error) {
    const record: BenchmarkRunRecord = {
      ...createRecord(),
      error: error instanceof Error ? error.message : String(error),
    };
    const recordPath = path.join(runRoot, "record.json");
    if (!existsSync(recordPath)) {
      writeJsonAtomic(recordPath, record);
    }
    throw error;
  }
}

async function runSetupCommand(
  context: BenchmarkContext,
  side: BenchmarkSide,
  packageManager: PackageManagerIdentity,
  deadline: VitestPairDeadline,
): Promise<void> {
  deadline.throwIfExpired();
  const checkout = side === "baseline" ? context.baselineDir : context.candidateDir;
  const setupRoot = path.join(context.scratchDir, "setup", side);
  const setupLogRoot = path.join(context.outputDir, "setup", side);
  const home = path.join(setupRoot, "home");
  const store = path.join(setupRoot, "pnpm-store");
  const cacheRoot = path.join(setupRoot, "cache");
  mkdirSync(path.join(cacheRoot, "tmp"), { recursive: true });
  const result = await runOwnedCommand({
    bin: context.pnpmBin,
    args: ["install", "--frozen-lockfile", "--store-dir", store],
    cwd: checkout,
    env: buildBenchmarkCommandEnv(home, cacheRoot, packageManager),
    logPath: path.join(setupLogRoot, "install.log"),
    deadline,
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${side} frozen install exited with status ${result.exitCode}`);
  }
}

function gitOutput(cwd: string, args: string[], deadline?: VitestPairDeadline): string {
  deadline?.throwIfExpired();
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(deadline ? { timeout: Math.max(1, deadline.deadlineAt - Date.now()) } : {}),
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
  deadline?.throwIfExpired();
  return result.stdout.trim();
}

function commandVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
  deadline?: VitestPairDeadline,
): string {
  deadline?.throwIfExpired();
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`unable to execute ${bin} --version`);
  }
  deadline?.throwIfExpired();
  return result.stdout.trim();
}

function collectArtifactHashes(root: string) {
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).toSorted()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (
        stat.isFile() &&
        relative !== "artifact-manifest.json" &&
        relative !== "terminal-manifest.json"
      ) {
        entries.push({
          path: relative,
          sha256: sha256(readFileSync(absolute)),
          bytes: stat.size,
        });
      }
    }
  };
  visit(root);
  return entries;
}

type NodeCacheContext = {
  workloadDir: string;
  seedDir: string;
  outputDir: string;
  scratchDir: string;
  pnpmBin: string;
  manifest: NodeCacheManifest;
};

type NodeCacheQualification = {
  manifest: NodeCacheManifest;
  preparedSha256: string;
  provenance: unknown;
  revalidate: () => void;
};

type QualifiedExecution = {
  deadline: VitestPairDeadline;
  checkOutput: () => void;
  qualification: NodeCacheQualification;
};

export async function runQualifiedNodeCacheBenchmark(input: {
  workloadDir: string;
  qualificationDir: string;
  outputDir: string;
  scratchDir: string;
  pnpmBin: string;
  timeoutMs: number;
  admit: (deadline: VitestPairDeadline) => NodeCacheQualification;
}): Promise<void> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 150 * 60_000
  ) {
    throw new Error("Qualified measurement requires a deadline of at most 150 minutes");
  }
  const output = path.resolve(input.outputDir);
  const scratch = path.resolve(input.scratchDir);
  const harness = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const workload = realpathSync(input.workloadDir);
  const qualification = realpathSync(input.qualificationDir);
  const roots = [output, scratch, harness, workload, qualification];
  if (
    roots.some((root, i) =>
      roots.some((other, j) => i !== j && (root === other || root.startsWith(other + path.sep))),
    )
  ) {
    throw new Error("Qualified measurement paths must be outside both checkouts and disjoint");
  }
  for (const directory of [output, scratch]) {
    if (
      existsSync(directory) ||
      realpathSync(path.dirname(directory)) !== path.dirname(directory)
    ) {
      throw new Error("Qualified measurement requires absent directories with physical parents");
    }
  }
  const checkOutput = ownedDirectory(output);
  await withTerminalManifest(
    output,
    async () => {
      await withVitestPairDeadline(async (deadline) => {
        const admitted = input.admit(deadline);
        deadline.throwIfExpired();
        writeJsonAtomic(path.join(output, "qualification.json"), admitted.provenance);
        writeJsonAtomic(path.join(output, "manifest.json"), admitted.manifest);
        const probe = spawnSync("/usr/bin/time", ["--version"], {
          encoding: "utf8",
          timeout: Math.max(1, Math.min(10_000, deadline.deadlineAt - Date.now())),
          env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
        });
        if (probe.error || probe.status !== 0 || !/GNU [Tt]ime/u.test(probe.stdout)) {
          throw new Error("Qualified measurement requires GNU /usr/bin/time");
        }
        deadline.throwIfExpired();
        await runNodeCacheBenchmark(
          {
            workloadDir: workload,
            seedDir: path.join(qualification, "seed"),
            outputDir: output,
            scratchDir: scratch,
            pnpmBin: input.pnpmBin,
            manifest: admitted.manifest,
          },
          { deadline, checkOutput, qualification: admitted },
        );
      }, input.timeoutMs);
    },
    checkOutput,
  );
}

export function readNodeCacheSeed(root: string): NodeCacheManifest["seed"]["files"] {
  const files: NodeCacheManifest["seed"]["files"] = [];
  const visit = (dir: string) => {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
      throw new Error("Node cache seed must contain only regular directories and files");
    }
    for (const name of readdirSync(dir).toSorted()) {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        files.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          bytes: stat.size,
          sha256: sha256(readFileSync(file)),
        });
      } else {
        throw new Error("Node cache seed must contain only regular directories and files");
      }
    }
  };
  visit(root);
  return files;
}

function assertSeed(context: NodeCacheContext) {
  const actual = readNodeCacheSeed(context.seedDir);
  const key = (files: typeof actual) =>
    JSON.stringify(
      files
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .map(({ path: filePath, bytes, sha256: digest }) => [filePath, bytes, digest]),
    );
  if (key(actual) !== key(context.manifest.seed.files)) {
    throw new Error("Node cache seed identity differs");
  }
}

export function restoreNodeCacheSeed(seed: string, destination: string) {
  const expected = readNodeCacheSeed(seed);
  cpSync(seed, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  });
  const makeWritable = (dir: string) => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        makeWritable(file);
      } else if (stat.isFile()) {
        chmodSync(file, 0o600);
      } else {
        throw new Error("Restored Node cache contains a non-regular entry");
      }
    }
  };
  makeWritable(destination);
  if (JSON.stringify(readNodeCacheSeed(destination)) !== JSON.stringify(expected)) {
    throw new Error("Restored Node cache bytes differ");
  }
}

function assertPreparedInputs(context: NodeCacheContext) {
  for (const entry of context.manifest.inputs) {
    const file = realpathSync(path.join(context.workloadDir, entry.path));
    if (
      !file.startsWith(`${context.workloadDir}${path.sep}`) ||
      !statSync(file).isFile() ||
      statSync(file).size !== entry.bytes ||
      sha256(readFileSync(file)) !== entry.sha256
    ) {
      throw new Error(`Prepared input identity differs: ${entry.path}`);
    }
  }
}

export function ownedDirectory(dir: string) {
  mkdirSync(dir, { mode: 0o700 });
  const identity = lstatSync(dir);
  return () => {
    const current = lstatSync(dir);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error("Benchmark directory ownership changed; retaining state");
    }
  };
}

export async function runNodeCacheBenchmark(
  input: NodeCacheContext,
  qualified?: QualifiedExecution,
): Promise<void> {
  const workload = realpathSync(input.workloadDir);
  const seed = path.resolve(input.seedDir);
  const output = path.resolve(input.outputDir);
  const scratch = path.resolve(input.scratchDir);
  const roots = [workload, seed, output, scratch];
  if (
    roots.some((root, i) =>
      roots.some((other, j) => i !== j && (root === other || root.startsWith(other + path.sep))),
    )
  ) {
    throw new Error("Workload, seed, output and scratch must be disjoint");
  }
  for (const dir of [seed, output, scratch]) {
    if (realpathSync(path.dirname(dir)) !== path.dirname(dir)) {
      throw new Error("Benchmark paths must have physical parents");
    }
  }
  const pnpm = realpathSync(input.pnpmBin);
  const runtime = input.manifest.runtime;
  const context = {
    ...input,
    pnpmBin: pnpm,
    workloadDir: workload,
    seedDir: seed,
    outputDir: output,
    scratchDir: scratch,
  };
  const assertInputs = () => {
    if (
      process.version !== runtime.node ||
      process.versions.v8 !== runtime.v8 ||
      process.platform !== runtime.platform ||
      process.arch !== runtime.architecture ||
      sha256(readFileSync(process.execPath)) !== runtime.executableSha256 ||
      sha256(readFileSync(pnpm)) !== context.manifest.pnpmSha256
    ) {
      throw new Error("Prepared benchmark runtime identity differs");
    }
    if (
      gitOutput(workload, ["rev-parse", "HEAD"], qualified?.deadline) !==
      context.manifest.workloadSha
    ) {
      throw new Error("Prepared workload SHA differs");
    }
    assertPreparedInputs(context);
    assertSeed(context);
    if (
      gitOutput(
        workload,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        qualified?.deadline,
      )
    ) {
      throw new Error("Prepared workload must have clean tracked and untracked state");
    }
  };
  assertInputs();
  const checkOutput = qualified?.checkOutput ?? ownedDirectory(output);
  const terminal = qualified
    ? async (_output: string, task: () => Promise<void>) => task()
    : withTerminalManifest;
  await terminal(
    output,
    async () => {
      const checkScratch = ownedDirectory(scratch);
      const packageManager = {
        executable: pnpm,
        resolvedExecutable: pnpm,
        version: "unprobed; executable digest-bound",
      };
      const schedule = buildNodeCacheSchedule();
      writeJsonAtomic(path.join(output, "environment.json"), {
        version: 2,
        mode: "node-compile-cache",
        runtime,
        pnpmSha256: context.manifest.pnpmSha256,
        workloadSha: context.manifest.workloadSha,
        manifestSha256: sha256(JSON.stringify(context.manifest)),
        inputs: context.manifest.inputs,
        seed: context.manifest.seed,
        schedule,
        tsxCachePolicy:
          "Ordinary tooling shims disable TSX disk caching; non-tooling Vitest children use fresh owned namespaces with within-invocation reuse and joined cleanup. Namespace paths are randomized and may be relocated; this is not universal TSX enablement.",
        workerCachePolicy:
          "Retained compiled-worker reuse is disabled; fresh compiled-worker generations may still be created.",
        limitations:
          "Workload/dependency correctness, seed preparation and effective prepared-config policies require separate external qualification. Full prepared bytes, modes and internal links are compared before and after the schedule; this is not continuous mutation detection. launchEnv records initial launcher inputs, including a one-worker request, not enforced descendant settings. No native cache-acceptance claim.",
        timingBoundary:
          "Active preparation, child exit/cache persistence and tree join, oracle and owned cleanup included; final record serialization excluded. Full prepared-inventory scans are outside per-pair timing and inside the aggregate deadline.",
        resourceScope:
          "GNU time child CPU only; parent restore/admission/cleanup CPU and RSS unavailable",
      });
      let allSettled = true;
      let failure: Error | undefined;
      const records: NodeCacheMeasurement[] = [];
      try {
        const runWithDeadline = qualified
          ? async (task: (deadline: VitestPairDeadline) => Promise<void>) =>
              task(qualified.deadline)
          : withVitestPairDeadline;
        await runWithDeadline(async (deadline) => {
          let prepared: PreparedEntry[] | undefined;
          const integrityFile = path.join(output, "prepared-integrity.json");
          const scope =
            "All regular bytes, file modes and internal symlink targets; only root Git metadata excluded. Pre/post comparison only, not continuous mutation detection.";
          try {
            prepared = await inventoryPreparedWorkload(workload, deadline);
            if (
              qualified &&
              sha256(JSON.stringify(prepared)) !== qualified.qualification.preparedSha256
            ) {
              throw new Error("Prepared workload differs from successful controls");
            }
            checkOutput();
            writeJsonAtomic(path.join(output, "prepared-inventory.json"), prepared);
            writeJsonAtomic(integrityFile, {
              version: 1,
              status: "pending",
              scope,
              beforeSha256: sha256(JSON.stringify(prepared)),
            });
            for (const plan of schedule) {
              const id = "pair-" + plan.pair + "-" + plan.treatment;
              const active = path.join(scratch, "active");
              const runRoot = path.join(output, id);
              const nodeCache = path.join(active, "node-compile");
              const reportPath = path.join(runRoot, "vitest-report.json");
              const timePath = path.join(runRoot, "gnu-time.txt");
              const command = [
                "/usr/bin/time",
                "-v",
                "-o",
                timePath,
                process.execPath,
                ...buildNodeCacheVitestArgs(context.manifest.lane, reportPath),
              ];
              const phases: Record<string, number | null> = {
                prepareMs: null,
                executePersistAndJoinMs: null,
                validateMs: null,
                cleanupMs: null,
              };
              let checkActive: (() => void) | undefined;
              let env: NodeJS.ProcessEnv | null = null;
              let settled = true;
              let cleaned = false;
              let caseFailure: Error | undefined;
              let result: RunCommandResult | undefined;
              let execution: BenchmarkExecutionSummary | null = null;
              let cpu: ReturnType<typeof parseGnuTime> | null = null;
              const started = process.hrtime.bigint();
              const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000;
              try {
                deadline.throwIfExpired();
                checkOutput();
                checkScratch();
                checkActive = ownedDirectory(active);
                mkdirSync(runRoot);
                if (plan.treatment === "seeded") {
                  restoreNodeCacheSeed(seed, nodeCache);
                } else {
                  mkdirSync(nodeCache);
                }
                env = buildBenchmarkCommandEnv(
                  path.join(active, "home"),
                  path.join(active, "state"),
                  packageManager,
                  process.env,
                  { kind: plan.treatment, nodeCache },
                );
                phases.prepareMs = elapsed();
                settled = false;
                result = await runOwnedCommand({
                  bin: command[0]!,
                  args: command.slice(1),
                  cwd: workload,
                  env,
                  logPath: path.join(runRoot, "command.log"),
                  deadline,
                });
                settled = true;
                phases.executePersistAndJoinMs = elapsed() - phases.prepareMs;
                if (result.exitCode !== 0) {
                  throw new Error(id + " exited with status " + result.exitCode);
                }
                cpu = parseGnuTime(timePath);
                execution = parseVitestExecutionReport(
                  reportPath,
                  workload,
                  context.manifest.lane,
                  context.manifest.expected,
                );
                phases.validateMs = elapsed() - phases.prepareMs - phases.executePersistAndJoinMs;
              } catch (error) {
                caseFailure = normalizeError(error);
              } finally {
                allSettled &&= settled;
                if (checkActive && settled) {
                  const cleanupStart = elapsed();
                  try {
                    checkScratch();
                    checkActive();
                    rmSync(active, { recursive: true });
                    cleaned = true;
                    phases.cleanupMs = elapsed() - cleanupStart;
                  } catch (error) {
                    caseFailure ??= normalizeError(error);
                  }
                }
              }
              const record = {
                ...plan,
                id,
                status: caseFailure ? ("failure" as const) : ("success" as const),
                inclusiveMs: cleaned ? elapsed() : null,
                phases,
                command,
                launchEnv: env,
                execution,
                exitCode: result?.exitCode ?? null,
                userCpuMs: cpu?.userCpuMs ?? null,
                systemCpuMs: cpu?.systemCpuMs ?? null,
                processTreeSettled: settled,
                cleanup: cleaned ? "removed-owned-active" : "retained-or-not-created",
                ...(caseFailure ? { error: caseFailure.message } : {}),
              };
              // The summary cannot time its own serialization. A failed write aborts
              // the experiment rather than admitting an unrecorded pair.
              checkOutput();
              writeJsonAtomic(path.join(output, id + ".json"), record);
              if (caseFailure) {
                throw caseFailure;
              }
              records.push(record);
            }
          } catch (error) {
            failure ??= normalizeError(error);
          } finally {
            if (prepared && allSettled) {
              try {
                const after = await inventoryPreparedWorkload(workload, deadline);
                const delta = preparedInventoryDelta(prepared, after);
                const unchanged = delta.beforeSha256 === delta.afterSha256;
                checkOutput();
                writeJsonAtomic(integrityFile, {
                  version: 1,
                  scope,
                  status: unchanged ? "unchanged" : "changed",
                  ...delta,
                });
                if (!unchanged) {
                  failure ??= new Error("Prepared workload changed during the schedule");
                }
              } catch (error) {
                checkOutput();
                writeJsonAtomic(integrityFile, {
                  version: 1,
                  scope,
                  status: "unverified",
                  error: normalizeError(error).message,
                  beforeSha256: sha256(JSON.stringify(prepared)),
                });
                failure ??= normalizeError(error);
              }
            } else {
              checkOutput();
              writeJsonAtomic(integrityFile, {
                version: 1,
                scope,
                status: "unverified",
                error: allSettled
                  ? "Initial inventory unavailable"
                  : "Child settlement uncertain; workload not inspected",
              });
            }
          }
          if (failure) {
            throw failure;
          }
        });
      } catch (error) {
        failure = normalizeError(error);
      } finally {
        // Do not inspect or remove a workload while an uncertain child may own it.
        if (allSettled) {
          try {
            qualified?.deadline.throwIfExpired();
            assertInputs();
            if (qualified) {
              qualified.deadline.throwIfExpired();
              qualified.qualification.revalidate();
              qualified.deadline.throwIfExpired();
            }
          } catch (error) {
            failure ??= normalizeError(error);
          }
        }
      }
      if (failure) {
        throw failure;
      }
      writeJsonAtomic(path.join(output, "analysis.json"), analyzeNodeCacheBenchmark(records));
      checkScratch();
      rmdirSync(scratch);
      checkOutput();
      writeJsonAtomic(path.join(output, "artifact-manifest.json"), {
        version: 2,
        files: collectArtifactHashes(output),
      });
    },
    checkOutput,
  );
}

export async function runVitestPairBenchmark(context: BenchmarkContext): Promise<void> {
  await withVitestPairDeadline(async (deadline) => {
    await runVitestPairBenchmarkBeforeDeadline(context, deadline);
  });
}

async function runVitestPairBenchmarkBeforeDeadline(
  context: BenchmarkContext,
  deadline: VitestPairDeadline,
): Promise<void> {
  deadline.throwIfExpired();
  if (process.platform !== "linux") {
    throw new Error("vitest-pair benchmark requires Linux");
  }
  assertExactSha(context.baselineSha, "baseline SHA");
  assertExactSha(context.candidateSha, "candidate SHA");
  const baselineDir = realpathSync(context.baselineDir);
  const candidateDir = realpathSync(context.candidateDir);
  if (gitOutput(baselineDir, ["rev-parse", "HEAD"], deadline) !== context.baselineSha) {
    throw new Error("baseline checkout does not match the requested SHA");
  }
  if (gitOutput(candidateDir, ["rev-parse", "HEAD"], deadline) !== context.candidateSha) {
    throw new Error("candidate checkout does not match the requested SHA");
  }
  if (process.version !== "v24.22.1") {
    throw new Error(`vitest-pair benchmark requires Node v24.22.1, got ${process.version}`);
  }
  mkdirSync(context.outputDir, { recursive: true });
  mkdirSync(context.scratchDir, { recursive: true });
  const packageManager = resolvePackageManagerIdentity(
    context.pnpmBin,
    path.join(context.scratchDir, "package-manager-probe"),
    process.env,
    deadline,
  );
  deadline.throwIfExpired();
  if (packageManager.version !== "12.15.0") {
    throw new Error(`vitest-pair benchmark requires pnpm 12.15.0, got ${packageManager.version}`);
  }
  const baselineInventory = assertInventoryAvailable(baselineDir, context.manifest);
  const candidateInventory = assertInventoryAvailable(candidateDir, context.manifest);
  assertEquivalentInventories(baselineInventory, candidateInventory);
  writeJsonAtomic(path.join(context.outputDir, "environment.json"), {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    packageManager,
    aggregateDeadlineMs: VITEST_PAIR_HARNESS_DEADLINE_MS,
    deadlineAt: new Date(deadline.deadlineAt).toISOString(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    baselineSha: context.baselineSha,
    baselineTree: gitOutput(baselineDir, ["rev-parse", "HEAD^{tree}"], deadline),
    candidateSha: context.candidateSha,
    candidateTree: gitOutput(candidateDir, ["rev-parse", "HEAD^{tree}"], deadline),
    inventorySha256: baselineInventory.inventorySha256,
  });
  writeJsonAtomic(path.join(context.outputDir, "inventory-baseline.json"), baselineInventory);
  writeJsonAtomic(path.join(context.outputDir, "inventory-candidate.json"), candidateInventory);
  await runSetupCommand(context, "baseline", packageManager, deadline);
  await runSetupCommand(context, "candidate", packageManager, deadline);

  const correctness: BenchmarkRunRecord[] = [];
  const correctnessDigests = new Map<string, string>();
  for (const lane of context.manifest.lanes) {
    const laneRecords = new Map<BenchmarkSide, BenchmarkRunRecord>();
    for (const side of ["baseline", "candidate"] as const) {
      deadline.throwIfExpired();
      const record = await runBenchmarkCommand(
        context,
        {
          id: `correctness-${lane.id}-${side}`,
          phase: "correctness",
          side,
          lane,
          round: null,
          pair: null,
          cacheMode: "fresh",
        },
        packageManager,
        deadline,
      );
      correctness.push(record);
      laneRecords.set(side, record);
    }
    const baselineExecution = laneRecords.get("baseline")?.execution;
    const candidateExecution = laneRecords.get("candidate")?.execution;
    if (!baselineExecution || !candidateExecution) {
      throw new Error(`correctness execution inventory is missing for lane ${lane.id}`);
    }
    assertExecutionDigest(
      candidateExecution,
      baselineExecution.digest,
      `correctness lane ${lane.id}`,
    );
    correctnessDigests.set(lane.id, baselineExecution.digest);
  }
  writeJsonAtomic(path.join(context.outputDir, "correctness-manifest.json"), {
    version: 1,
    status: "success",
    inventorySha256: baselineInventory.inventorySha256,
    executionDigests: Object.fromEntries(correctnessDigests),
    records: correctness,
  });

  // Timing state does not exist until both sides pass every correctness lane.
  mkdirSync(path.join(context.outputDir, "timing"), { recursive: false });
  const records: BenchmarkRunRecord[] = [];
  for (const plan of buildBenchmarkSchedule(context.manifest)) {
    deadline.throwIfExpired();
    const expectedExecutionDigest = correctnessDigests.get(plan.lane.id);
    if (!expectedExecutionDigest) {
      throw new Error(`correctness execution digest is missing for lane ${plan.lane.id}`);
    }
    records.push(
      await runBenchmarkCommand(context, plan, packageManager, deadline, expectedExecutionDigest),
    );
  }
  writeJsonAtomic(path.join(context.outputDir, "timing", "records.json"), {
    version: 1,
    records,
  });
  const analysis = analyzeBenchmark(records, context.manifest);
  writeJsonAtomic(path.join(context.outputDir, "analysis.json"), analysis);
  writeJsonAtomic(path.join(context.outputDir, "artifact-manifest.json"), {
    version: 1,
    files: collectArtifactHashes(context.outputDir),
  });
  if (analysis.verdict !== "pass") {
    throw new Error(
      `vitest-pair benchmark detected regression: ${analysis.regressions.join("; ")}`,
    );
  }
}
