// Splits oxlint into resource-aware shards with heartbeat and timeout handling.
import { randomUUID } from "node:crypto";
import fs, { type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommandCancellation, runCancelableCommand } from "./lib/cancelable-command.mts";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import {
  CI_PARALLEL_MIN_MEMORY_BYTES,
  isConstrainedCiCheckHost,
  resolveLocalCheckEnv,
} from "./lib/local-check-runtime.mts";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";
import { prepareExtensionPackageBoundaryArtifacts } from "./prepare-extension-package-boundary-artifacts.mts";
import { runOxlint, shouldPrepareExtensionPackageBoundaryArtifacts } from "./run-oxlint.mts";

const DEFAULT_EXTENSION_CHUNK_SIZE = 8;
const LARGE_CI_EXTENSION_CHUNK_SIZE = 16;
const LARGE_CI_EXTENSION_MIN_MEMORY_BYTES = 15 * 1024 ** 3;
const DEFAULT_CONSTRAINED_CORE_STRIPES = 5;
const DEFAULT_SHARD_HEARTBEAT_MS = 30_000;
const DEFAULT_SHARD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SHARD_KILL_GRACE_MS = 5_000;
const FAST_LOCAL_CHECK_MIN_CPUS = 12;
const FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * 1024 ** 3;
const EXTENSION_TS_CONFIG = "extensions/tsconfig.json";
const EXTENSIONS_DIR = "extensions";
const OXLINT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;

type OxlintShard = { name: string; args: string[] };
type ShardStripe = { index: number; total: number };
type HostResources = {
  logicalCpuCount: number;
  totalMemoryBytes: number;
  memoryCapacityBytes?: number | null;
};
type ReadDirectoryEntries = (target: string, options: { withFileTypes: true }) => Dirent[];
type DirectoryOptions = { cwd?: string; readDir?: ReadDirectoryEntries };
type DirectoryLookup = Required<DirectoryOptions>;
type ShardOptions = DirectoryOptions & { env?: NodeJS.ProcessEnv };
type PlatformOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
type PlatformShardOptions = ShardOptions &
  ResourceOptions & { splitCore?: boolean; splitExtensions?: boolean };
type ResourceOptions = PlatformOptions & { hostResources?: HostResources };
type RunnerOptions = {
  env: NodeJS.ProcessEnv;
  extraArgs: string[];
  signal: AbortSignal;
};
type ShardRunnerOptions = RunnerOptions & { shard: OxlintShard; onCompleted?: () => void };
type ShardBatchOptions = RunnerOptions & {
  entries: OxlintShard[];
  evidenceId?: string;
};
const CORE_SHARD = {
  name: "core",
  args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
};
const CORE_TS_CONFIG = "config/tsconfig/oxlint.core.json";
const CORE_SPLIT_TARGETS = ["ui", "packages"];
// Combining these targets with neighbors exceeds hosted RAM despite Go's soft heap limit.
const ISOLATED_CORE_TARGETS = new Set(["src/agents", "src/gateway", "src/infra", "ui"]);
const EXTENSIONS_SHARD = {
  name: "extensions",
  args: ["--tsconfig", EXTENSION_TS_CONFIG, EXTENSIONS_DIR],
};
const SCRIPTS_SHARD = {
  name: "scripts",
  args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
};

async function lintWorkspacePackages(cwd: string): Promise<string[] | undefined> {
  const { parse: parseYaml } = await import("yaml");
  const workspace: unknown = parseYaml(
    fs.readFileSync(path.join(cwd, "pnpm-workspace.yaml"), "utf8"),
  );
  if (
    !workspace ||
    typeof workspace !== "object" ||
    !("packages" in workspace) ||
    !Array.isArray(workspace.packages) ||
    !workspace.packages.every((entry) => typeof entry === "string" && !entry.startsWith("!"))
  ) {
    return undefined;
  }
  const roots = [
    ...new Set(
      workspace.packages.flatMap((pattern: string) =>
        (pattern === "." ? ["."] : [...fs.globSync(pattern, { cwd })])
          .filter((root) => fs.existsSync(path.join(cwd, root, "package.json")))
          .map((root) => root.replaceAll(path.sep, "/")),
      ),
    ),
  ];
  return roots.includes(".")
    ? roots.toSorted((left, right) => right.length - left.length)
    : undefined;
}

/** Workspace metadata owns package boundaries; test/ remains outside full semantic lint. */
export async function resolveChangedOxlintPackageScope(
  files: readonly string[],
  cwd = process.cwd(),
) {
  const roots = await lintWorkspacePackages(cwd);
  if (!roots) {
    return undefined;
  }
  const selected = new Set<string>();
  for (const file of files) {
    if (
      path.isAbsolute(file) ||
      file !== file.trim() ||
      file.split("/").includes("..") ||
      !OXLINT_SOURCE_FILE_PATTERN.test(file) ||
      /\.d\.[cm]?ts$/u.test(file) ||
      !fs.existsSync(path.join(cwd, file))
    ) {
      return undefined;
    }
    const owner = roots.find((root) => root !== "." && file.startsWith(`${root}/`)) ?? ".";
    selected.add(owner);
  }
  return prepareOxlintPackageScope(roots, [...selected].toSorted(), cwd);
}

/** Filter after stripe assignment so package scope never changes execution ownership. */
export async function createOxlintPackageScope(packages: readonly string[], cwd = process.cwd()) {
  const roots = await lintWorkspacePackages(cwd);
  if (!roots) {
    throw new Error("Oxlint package selection requires canonical workspace roots");
  }
  return prepareOxlintPackageScope(roots, packages, cwd);
}

function prepareOxlintPackageScope(
  roots: readonly string[],
  packages: readonly string[],
  cwd: string,
) {
  const selected = new Set(packages);
  if (selected.size !== packages.length || packages.some((root) => !roots.includes(root))) {
    throw new Error("Oxlint package selection must name unique canonical workspace roots");
  }
  const project = (target: string): string[] => {
    const owner =
      roots.find((root) => root !== "." && (target === root || target.startsWith(`${root}/`))) ??
      ".";
    const nested = roots.filter((root) => root !== "." && root.startsWith(`${target}/`));
    if (!selected.has(owner)) {
      return nested.filter((root) => selected.has(root));
    }
    if (nested.length === 0) {
      return fs.statSync(path.join(cwd, target)).isDirectory() ||
        OXLINT_SOURCE_FILE_PATTERN.test(target)
        ? [target]
        : [];
    }
    // A canonical container such as packages/ can contain both workspace
    // packages and root-owned files. Split only along declared package roots.
    return fs.readdirSync(path.join(cwd, target)).flatMap((entry) => project(`${target}/${entry}`));
  };
  return {
    packages: [...selected].toSorted(),
    selectShards(shards: readonly OxlintShard[]) {
      return shards.flatMap((shard) => {
        const targets = [...new Set(shard.args.slice(2).flatMap(project))];
        return targets.length ? [{ ...shard, args: [...shard.args.slice(0, 2), ...targets] }] : [];
      });
    },
  };
}

export function createOxlintShards({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  hostResources = resolveHostResources(),
  readDir = fs.readdirSync,
  splitCore = false,
  splitExtensions = false,
}: PlatformShardOptions = {}) {
  const constrainedSerial =
    hostResources.totalMemoryBytes < CI_PARALLEL_MIN_MEMORY_BYTES &&
    shouldRunOxlintShardsSerial({ env, platform, hostResources });
  const coreGroups =
    splitCore || constrainedSerial ? createCoreOxlintShards({ cwd, readDir }) : [CORE_SHARD];
  // Bound semantic checker caches without rebuilding the full type graph for every directory.
  const coreShards =
    constrainedSerial && !splitCore
      ? Array.from({ length: DEFAULT_CONSTRAINED_CORE_STRIPES }, (_, index) =>
          selectCoreOxlintStripe(coreGroups, {
            index: index + 1,
            total: DEFAULT_CONSTRAINED_CORE_STRIPES,
          }),
        ).flat()
      : coreGroups;
  // Unsplit plugin lint can exceed small-host RAM even with a single lint thread.
  // Chunk serial runs; explicit stripes use independently bounded Programs that stay serial.
  const chunkExtensions = splitExtensions || platform === "win32" || constrainedSerial;
  // Larger serial Programs amortize type-graph startup on the measured Linux CI
  // class. Unknown/ancestor-constrained memory and explicit stripes retain eight.
  const extensionChunkSize =
    platform === "linux" &&
    (env.CI === "true" || env.GITHUB_ACTIONS === "true") &&
    constrainedSerial &&
    !splitExtensions &&
    !env.OPENCLAW_OXLINT_SHARDS_SERIAL?.trim() &&
    hostResources.logicalCpuCount >= 4 &&
    (hostResources.memoryCapacityBytes ?? 0) >= LARGE_CI_EXTENSION_MIN_MEMORY_BYTES
      ? LARGE_CI_EXTENSION_CHUNK_SIZE
      : DEFAULT_EXTENSION_CHUNK_SIZE;
  const extensionShards = chunkExtensions
    ? createExtensionOxlintShards({ cwd, env, platform, readDir, chunkSize: extensionChunkSize })
    : [EXTENSIONS_SHARD];

  return [...coreShards, ...extensionShards, SCRIPTS_SHARD];
}

function createCoreOxlintShards({
  cwd = process.cwd(),
  readDir = fs.readdirSync,
}: DirectoryOptions = {}) {
  const sourceShards = listSourceRootTargetGroups({ cwd, readDir }).map((targets) => ({
    name: targets.length === 1 ? `core:${targets.join("").replaceAll("/", ":")}` : "core:src:root",
    args: ["--tsconfig", CORE_TS_CONFIG, ...targets],
  }));
  const sourceEntries = sourceShards.length > 0 ? sourceShards : [createCoreShard("src")];

  return [...sourceEntries, ...CORE_SPLIT_TARGETS.map((target) => createCoreShard(target))];
}

function createCoreShard(target: string) {
  return {
    name: `core:${target}`,
    args: ["--tsconfig", CORE_TS_CONFIG, target],
  };
}

/**
 * Chunks plugin lint targets for Windows and memory-constrained serial runs.
 */
export function createExtensionOxlintShards({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  readDir = fs.readdirSync,
  chunkSize: requestedChunkSize = DEFAULT_EXTENSION_CHUNK_SIZE,
}: ShardOptions & PlatformOptions & { chunkSize?: number } = {}) {
  const entries = listOxlintRootEntries(EXTENSIONS_DIR, { cwd, readDir });
  if (entries.dirs.length === 0 && entries.rootFiles.length === 0) {
    return [EXTENSIONS_SHARD];
  }

  const chunkSize =
    platform === "win32" ? resolveWindowsExtensionChunkSize(env) : requestedChunkSize;
  const shards: OxlintShard[] = [];

  if (entries.rootFiles.length > 0) {
    shards.push({
      name: "extensions:root",
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...entries.rootFiles],
    });
  }

  for (let index = 0; index < entries.dirs.length; index += chunkSize) {
    const chunk = entries.dirs.slice(index, index + chunkSize);
    const chunkNumber = String(index / chunkSize + 1).padStart(2, "0");
    shards.push({
      name: `extensions:${chunkNumber}`,
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...chunk],
    });
  }
  return shards;
}

export function resolveWindowsExtensionChunkSize(env: NodeJS.ProcessEnv = process.env) {
  return (
    resolvePositiveEnvInt(env, "OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE") ??
    DEFAULT_EXTENSION_CHUNK_SIZE
  );
}

export function shouldRunOxlintShardsSerial({
  env = process.env,
  platform = process.platform,
  hostResources,
}: ResourceOptions = {}) {
  const explicitMode = env.OPENCLAW_OXLINT_SHARDS_SERIAL?.trim();
  if (explicitMode === "1") {
    return true;
  }
  if (platform === "win32") {
    return true;
  }
  if (explicitMode === "0") {
    return false;
  }
  const localCheckMode = env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();
  if (!isRemoteChangedGateEnv(env)) {
    if (localCheckMode === "full" || localCheckMode === "fast") {
      return false;
    }
    if (localCheckMode === "throttled" || localCheckMode === "low-memory") {
      return true;
    }
  }
  const resources = resolveHostResources(hostResources);
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return isConstrainedCiCheckHost(resources);
  }
  return (
    resources.totalMemoryBytes < FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
    resources.logicalCpuCount < FAST_LOCAL_CHECK_MIN_CPUS
  );
}

function isRemoteChangedGateEnv(env: NodeJS.ProcessEnv) {
  return (
    env.OPENCLAW_CHECK_CHANGED_REMOTE_CHILD === "1" || env.OPENCLAW_CHANGED_LANES_RAW_SYNC === "1"
  );
}

function readDirectoryEntries(readDir: ReadDirectoryEntries, target: string) {
  try {
    return readDir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listOxlintRootEntries(root: string, { cwd, readDir }: DirectoryLookup) {
  const entries = readDirectoryEntries(readDir, path.join(cwd, root));

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${root}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
  const rootFiles = entries
    .filter((entry) => entry.isFile() && OXLINT_SOURCE_FILE_PATTERN.test(entry.name))
    .map((entry) => `${root}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));

  return {
    dirs,
    rootFiles,
  };
}

function listSourceRootTargetGroups(options: DirectoryLookup) {
  const { dirs, rootFiles } = listOxlintRootEntries("src", options);
  return [...dirs.map((target) => [target]), ...(rootFiles.length > 0 ? [rootFiles] : [])];
}

export async function main(
  extraArgs: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) {
  return runCancelableCommand((signal) => runOxlintShards(extraArgs, runtimeEnv, signal));
}

async function runOxlintShards(
  extraArgs: string[],
  runtimeEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const shardArgs = parseShardRunnerArgs(extraArgs);
  const env = resolveLocalCheckEnv(runtimeEnv);
  const hostResources = resolveHostResources();
  const splitExtensions = shardArgs.extensionStripe !== undefined;
  const shards = createOxlintShards({
    cwd: process.cwd(),
    env,
    platform: process.platform,
    hostResources,
    splitCore: shardArgs.splitCore,
    splitExtensions,
  });
  const stripedShards = selectExtensionOxlintStripe(
    selectCoreOxlintStripe(filterOxlintShards(shards, shardArgs.only), shardArgs.coreStripe, {
      isolateLargeTargets: true,
    }),
    shardArgs.extensionStripe,
  );
  const selectedShards = shardArgs.packages
    ? (await createOxlintPackageScope(shardArgs.packages)).selectShards(stripedShards)
    : stripedShards;

  const needsArtifacts = shouldPrepareExtensionPackageBoundaryArtifactsForShards(
    selectedShards,
    shardArgs.oxlintArgs,
  );
  const evidenceId = env.OPENCLAW_CI_STATIC_EVIDENCE === "1" ? randomUUID() : undefined;
  let completed = 0;
  const run = async () => {
    signal.throwIfAborted();
    if (needsArtifacts) {
      await prepareExtensionPackageBoundaryArtifacts(["--mode=package-boundary"], env, signal);
    }
    signal.throwIfAborted();
    // CPU count is not admission to retain multiple complete compiler graphs.
    // Keep target planning independent from the single active semantic leaf.
    console.error(
      `[oxlint] shard concurrency 1 ` +
        `(cpus=${hostResources.logicalCpuCount}, memGB=${Math.round(hostResources.totalMemoryBytes / 1024 ** 3)})`,
    );
    const results = await runShards({
      entries: selectedShards,
      env,
      extraArgs: shardArgs.oxlintArgs,
      signal,
      evidenceId,
    });
    completed = results.completed;
    return results.statuses.find((status) => status !== 0) ?? 0;
  };
  const status = needsArtifacts
    ? await withDistArtifactOwnership(process.cwd(), run, signal)
    : await run();
  signal.throwIfAborted();
  if (evidenceId && completed === selectedShards.length) {
    console.log(
      `[ci-static:oxlint:completion] ${JSON.stringify({
        version: 1,
        id: evidenceId,
        planned: selectedShards.length,
        completed,
        leaves: selectedShards.map((_, index) => `${evidenceId}:${index}`),
      })}`,
    );
  }
  return status;
}

if (import.meta.main) {
  // Imported batches leave final reporting to their outer pipeline, after ownership settles.
  await runWithFailedTrailer("oxlint", async () => {
    process.exitCode = await main();
  });
}

function resolveHostResources(hostResources?: HostResources) {
  if (hostResources) {
    return hostResources;
  }

  return {
    totalMemoryBytes: os.totalmem(),
    memoryCapacityBytes: readProcessMemoryCapacity({}).capacityBytes,
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  };
}

export function parseShardRunnerArgs(args: string[]) {
  const only = new Set<string>();
  const oxlintArgs: string[] = [];
  let coreStripe: ShardStripe | undefined;
  let extensionStripe: ShardStripe | undefined;
  let splitCore = false;
  let packages: string[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--packages-json") {
      const value: unknown = JSON.parse(args[index + 1] ?? "null");
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((root) => typeof root === "string")
      ) {
        throw new Error("--packages-json requires a nonempty JSON string array");
      }
      packages = value;
      index += 1;
      continue;
    }
    if (arg === "--split-core") {
      splitCore = true;
      continue;
    }
    if (arg === "--core-stripe") {
      coreStripe = parseShardStripe(args[index + 1], "--core-stripe");
      index += 1;
      continue;
    }
    if (arg.startsWith("--core-stripe=")) {
      coreStripe = parseShardStripe(arg.slice("--core-stripe=".length), "--core-stripe");
      continue;
    }
    if (arg === "--extension-stripe") {
      extensionStripe = parseShardStripe(args[index + 1], "--extension-stripe");
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension-stripe=")) {
      extensionStripe = parseShardStripe(
        arg.slice("--extension-stripe=".length),
        "--extension-stripe",
      );
      continue;
    }
    if (arg === "--only") {
      only.add(requireShardSelector(args[index + 1]));
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      only.add(requireShardSelector(arg.slice("--only=".length)));
      continue;
    }
    oxlintArgs.push(arg);
  }

  if (coreStripe && !splitCore) {
    throw new Error("--core-stripe requires --split-core");
  }
  return {
    coreStripe,
    extensionStripe,
    only,
    oxlintArgs,
    splitCore,
    ...(packages ? { packages } : {}),
  };
}

function parseShardStripe(value: string | undefined, flag: string): ShardStripe {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    throw new Error(`${flag} requires INDEX/TOTAL with 1 <= INDEX <= TOTAL; got: ${value}`);
  }
  return { index, total };
}

export function filterOxlintShards<T extends { name: string }>(shards: T[], only: Set<string>) {
  if (only.size === 0) {
    return shards;
  }

  const selectors = [...only];
  const unknownSelectors = selectors.filter(
    (selector) => !shards.some((shard) => matchesShardSelector(shard, selector)),
  );
  if (unknownSelectors.length > 0) {
    throw new Error(
      `Unknown oxlint shard selector${unknownSelectors.length === 1 ? "" : "s"}: ${unknownSelectors.join(", ")}`,
    );
  }

  return shards.filter((shard) =>
    selectors.some((selector) => matchesShardSelector(shard, selector)),
  );
}

/** Keep stripe coverage stable while bounding the largest targets' semantic caches. */
export function selectCoreOxlintStripe(
  shards: OxlintShard[],
  stripe: ShardStripe | undefined,
  { isolateLargeTargets = false }: { isolateLargeTargets?: boolean } = {},
) {
  if (!stripe) {
    return shards;
  }
  if (shards.length === 0 || shards.some((shard) => !shard.name.startsWith("core:"))) {
    throw new Error("--core-stripe requires a non-empty core-only shard selection");
  }
  const targets = shards
    .filter((_, index) => index % stripe.total === stripe.index - 1)
    .flatMap((shard) => shard.args.slice(2));
  // Published Git updaters call full lint under a fixed command deadline. Only
  // explicit CI stripes may add compiler startups; automatic full lint stays aggregated.
  const isolatedTargets = isolateLargeTargets
    ? targets.filter((target) => ISOLATED_CORE_TARGETS.has(target))
    : [];
  const sharedTargets = targets.filter((target) => !isolatedTargets.includes(target));
  return [
    ...(sharedTargets.length > 0
      ? [
          {
            name: `core:stripe:${stripe.index}`,
            args: ["--tsconfig", CORE_TS_CONFIG, ...sharedTargets],
          },
        ]
      : []),
    ...isolatedTargets.map((target) => ({
      name: `core:stripe:${stripe.index}:${target.replaceAll("/", ":")}`,
      args: ["--tsconfig", CORE_TS_CONFIG, target],
    })),
  ];
}

/** Select one deterministic, disjoint stripe of independently bounded extension Programs. */
export function selectExtensionOxlintStripe(
  shards: OxlintShard[],
  stripe: ShardStripe | undefined,
) {
  if (!stripe) {
    return shards;
  }
  if (shards.length === 0) {
    return [];
  }
  if (shards.some((shard) => !shard.name.startsWith("extensions:"))) {
    throw new Error("--extension-stripe requires an extension-only shard selection");
  }
  return shards.filter((_, index) => index % stripe.total === stripe.index - 1);
}

export function shouldPrepareExtensionPackageBoundaryArtifactsForShards(
  shards: readonly OxlintShard[],
  extraArgs: readonly string[] = [],
) {
  return shards.some((shard) =>
    shouldPrepareExtensionPackageBoundaryArtifacts([...shard.args, ...extraArgs]),
  );
}

function requireShardSelector(value: string | undefined) {
  if (!value || value.startsWith("-")) {
    throw new Error("--only requires a shard name");
  }
  return value;
}

function matchesShardSelector(shard: { name: string }, selector: string) {
  return selector === shard.name || selector === shard.name.split(":")[0];
}

async function runShards({ entries, env, extraArgs, signal, evidenceId }: ShardBatchOptions) {
  let completed = 0;
  const statuses: number[] = [];
  for (const [index, shard] of entries.entries()) {
    signal.throwIfAborted();
    const targets = shard.args.slice(2);
    const boundedTargets =
      (shard.name.startsWith("core:") &&
        (targets.length === 1 || targets.every((target) => !ISOLATED_CORE_TARGETS.has(target)))) ||
      (shard.name.startsWith("extensions:") && targets.length <= DEFAULT_EXTENSION_CHUNK_SIZE);
    const boundedArgs =
      boundedTargets &&
      extraArgs.every((arg) => /^--(?:threads=[12]|format=(?:json|stylish))$/u.test(arg));
    const status = await runShard({
      env: {
        ...env,
        ...(evidenceId ? { OPENCLAW_CI_STATIC_EVIDENCE_ID: `${evidenceId}:${index}` } : {}),
        OPENCLAW_OXLINT_BATCH_CONCURRENCY: "1",
        OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS: boundedArgs
          ? JSON.stringify([...shard.args, ...extraArgs])
          : "",
      },
      extraArgs,
      signal,
      shard,
      onCompleted: () => {
        completed++;
      },
    });
    signal.throwIfAborted();
    statuses.push(status);
    // Join the failed leaf before returning. Later --fix shards must not mutate files.
    if (status !== 0) {
      break;
    }
  }
  return { statuses, completed };
}

async function runShard({ env, extraArgs, signal, shard, onCompleted }: ShardRunnerOptions) {
  signal.throwIfAborted();
  console.error(`[oxlint:${shard.name}] starting`);
  const startedAt = Date.now();
  const heartbeatMs = resolveShardHeartbeatMs(env);
  const timeoutMs = resolveShardTimeoutMs(env);
  const deadline = new AbortController();
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          console.error(`[oxlint:${shard.name}] still running after ${elapsedSeconds}s`);
        }, heartbeatMs)
      : undefined;
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          console.error(`[oxlint:${shard.name}] timed out; awaiting compiler cleanup`);
          deadline.abort();
        }, timeoutMs)
      : undefined;
  heartbeat?.unref();
  timeout?.unref();
  const finish = (status: number) => {
    console.error(`[oxlint:${shard.name}] ${status === 0 ? "passed" : `failed (exit ${status})`}`);
    return status;
  };
  try {
    // The managed leaf owns signal delivery and escalation. Killing a second
    // wrapper can destroy that owner before it joins the compiler and its outputs.
    const result = await runOxlint(
      [...shard.args, ...extraArgs],
      { ...env, OPENCLAW_OXLINT_SKIP_PREPARE: "1" },
      AbortSignal.any([signal, deadline.signal]),
      resolveShardKillGraceMs(env),
    );
    signal.throwIfAborted();
    if (deadline.signal.aborted) {
      return finish(124);
    }
    if (result.evidence) {
      console.log(`\n[ci-static:oxlint:leaf] ${JSON.stringify(result.evidence)}`);
    }
    // Serial leaves write their native report before their receipt. Missing or
    // truncated evidence cannot certify coverage of the whole batch.
    if (
      (result.status === 0 || result.status === 1) &&
      (env.OPENCLAW_CI_STATIC_EVIDENCE !== "1" || result.evidence)
    ) {
      onCompleted?.();
    }
    return finish(result.status);
  } catch (error) {
    // Cleanup uncertainty and unrelated failures must retain their error identity.
    // Parent cancellation wins over a concurrent shard deadline.
    if (deadline.signal.aborted && !signal.aborted && isCommandCancellation(error)) {
      return finish(124);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

export function resolveShardHeartbeatMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS",
    DEFAULT_SHARD_HEARTBEAT_MS,
  );
}

export function resolveShardTimeoutMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_TIMEOUT_MS",
    DEFAULT_SHARD_TIMEOUT_MS,
  );
}

export function resolveShardKillGraceMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS",
    DEFAULT_SHARD_KILL_GRACE_MS,
  );
}

function resolveNonNegativeEnvInt(env: NodeJS.ProcessEnv, key: string, defaultValue: number) {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  const text = rawValue.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${key} must be a non-negative integer; got: ${rawValue}`);
  }
  const parsedValue = Number(text);
  if (!Number.isSafeInteger(parsedValue)) {
    throw new Error(`${key} must be a non-negative integer; got: ${rawValue}`);
  }
  return parsedValue;
}

function resolvePositiveEnvInt(env: NodeJS.ProcessEnv, key: string) {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === "") {
    return null;
  }

  return parsePositiveEnvInt(rawValue, key);
}

function parsePositiveEnvInt(rawValue: string, key: string) {
  const text = rawValue.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${key} must be a positive integer; got: ${rawValue}`);
  }
  const parsedValue = Number(text);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${key} must be a positive integer; got: ${rawValue}`);
  }
  return parsedValue;
}
