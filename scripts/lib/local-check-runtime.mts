// Applies resource policy for expensive local and CI check commands.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
const DEFAULT_LOCAL_GO_GC = "30";
const DEFAULT_LOCAL_GO_MAX_PROCS = 2;
const DEFAULT_LOCAL_GO_MEMORY_LIMIT = "3GiB";
const DEFAULT_LOCAL_TSGO_BUILD_INFO_FILE = ".artifacts/tsgo-cache/root.tsbuildinfo";
const DEFAULT_FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * GIB;
const DEFAULT_FAST_LOCAL_CHECK_MIN_CPUS = 12;
const CI_PARALLEL_MIN_CPUS = 8;
export const CI_PARALLEL_MIN_MEMORY_BYTES = 24 * GIB;

const EXCLUSIVE_CI_TEST_CONFIGS = new Set([
  "test/vitest/vitest.gateway-core.config.ts",
  "test/vitest/vitest.gateway-database-workers.config.ts",
  "test/vitest/vitest.gateway-methods.config.ts",
  "test/vitest/vitest.gateway-methods-isolated.config.ts",
  "test/vitest/vitest.gateway-server.config.ts",
  "test/vitest/vitest.gateway-server-isolated.config.ts",
]);

export function isExclusiveCiTestConfig(config: string): boolean {
  return EXCLUSIVE_CI_TEST_CONFIGS.has(config);
}

type Env = NodeJS.ProcessEnv;
type Resources = {
  logicalCpuCount: number;
  totalMemoryBytes: number;
};

type LocalCheckMode = "auto" | "full" | "throttled";
type RepoToolOptions = {
  cwd?: string;
  fileExists?: (candidate: string) => boolean;
  resolveCommonDir?: (cwd: string) => string | null;
};
type NodeModulesLinkOptions = Pick<RepoToolOptions, "cwd" | "fileExists"> & {
  symlink?: typeof fs.symlinkSync;
  platform?: NodeJS.Platform;
};

/** Return whether local check safeguards are enabled for an environment. */
export function isLocalCheckEnabled(env: Env) {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

function isCiLikeEnv(env: Env = process.env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

// Small CI runners share one constraint check for shard concurrency and Go memory policy.
export function isConstrainedCiCheckHost(hostResources: Resources) {
  return !(
    hostResources.totalMemoryBytes >= CI_PARALLEL_MIN_MEMORY_BYTES &&
    hostResources.logicalCpuCount >= CI_PARALLEL_MIN_CPUS
  );
}

/** Ensure local check runs opt into safeguard environment outside CI. */
export function resolveLocalCheckEnv(env: Env = process.env) {
  if (isCiLikeEnv(env) || isLocalCheckEnabled(env)) {
    return env;
  }

  return {
    ...env,
    OPENCLAW_LOCAL_CHECK: "1",
  };
}

const withinRoot = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function findAncestorInstall(root: string, real: string): string | undefined {
  let ancestor = path.dirname(root);
  while (true) {
    const install = path.join(ancestor, "node_modules");
    if (withinRoot(install, real)) {
      return install;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return undefined;
    }
    ancestor = parent;
  }
}

export function createDeclarationInputBoundary(cwd: string) {
  const declared = path.resolve(cwd);
  const prefixes = [declared];
  if (fs.lstatSync(declared).isSymbolicLink()) {
    prefixes.push(path.resolve(path.dirname(declared), fs.readlinkSync(declared)));
  }
  prefixes.push(fs.realpathSync(declared));
  const root = fs.realpathSync.native(declared);
  // Runtimes differ on whether realpath preserves a case-only symlink target.
  // Translate only declared checkout spellings; never canonicalize outside candidates into scope.
  const resolve = (file: string) => {
    const absolute = path.resolve(declared, file);
    const prefix = prefixes.find((candidate) => withinRoot(candidate, absolute));
    return prefix ? path.resolve(root, path.relative(prefix, absolute)) : absolute;
  };
  return {
    root,
    resolve,
    assert(file: string) {
      const absolute = resolve(file);
      // Generated declaration IDs do not exist yet, but their source directory does.
      let existing = absolute;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
      }
      const real = fs.realpathSync.native(existing);
      if (!withinRoot(root, absolute) || !withinRoot(root, real)) {
        // Hermetic declaration inputs must not inherit an ancestor install's exposed packages.
        const ancestorInstall = findAncestorInstall(root, real);
        const diagnosis = ancestorInstall
          ? `This checkout is nested inside another install at ${ancestorInstall}. Module resolution can read candidate manifests there even with a complete local install and a checkout-local final resolution. Repeating pnpm install will not isolate ancestor lookup. Provision a separate physical checkout outside ancestor node_modules installations, run pnpm install --frozen-lockfile there, and rerun declaration preparation and its dependent checks there. Do not modify the ancestor install or share its node_modules.`
          : `Keep declaration dependencies and compiler files physically inside ${root}; shared installs and external symlinks are unsupported. Inspect the reported path and dependency links; this error alone does not establish a missing or undeclared dependency.`;
        throw new Error(`Declaration input escapes checkout: ${absolute} -> ${real}. ${diagnosis}`);
      }
      return absolute;
    },
  };
}

/** Resolve a repo tool from this worktree or the primary checkout's installed toolchain. */
export function resolveRepoToolBinPath(
  toolName: string,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    resolveCommonDir = resolveGitCommonDir,
  }: RepoToolOptions = {},
) {
  if (toolName === "tsgo") {
    // Resolve this checkout's native compiler independently of the ambient tsc bin link.
    const require = createRequire(import.meta.url);
    const inputs = createDeclarationInputBoundary(cwd);
    const fromCheckout = createRequire(path.join(inputs.root, "package.json"));
    const nativeRoot = path.dirname(inputs.assert(fromCheckout.resolve("typescript/package.json")));
    const getExePath: { default: () => string } = require(
      inputs.assert(path.join(nativeRoot, "lib/getExePath.js")),
    );
    const executable = getExePath.default();
    // Windows launches need the extended-length prefix; normalize only for admission.
    inputs.assert(fileURLToPath(pathToFileURL(executable)));
    return executable;
  }
  const localPath = path.resolve(cwd, "node_modules", ".bin", toolName);
  if (fileExists(localPath)) {
    return localPath;
  }

  const commonDir = resolveCommonDir(cwd);
  if (!commonDir || path.basename(commonDir) !== ".git") {
    return localPath;
  }

  // Linked worktrees share the primary checkout's .git directory. Its parent
  // owns the installed toolchain that dependency-less worktrees can reuse.
  const primaryPath = path.join(path.dirname(commonDir), "node_modules", ".bin", toolName);
  return fileExists(primaryPath) ? primaryPath : localPath;
}

/** Link explicitly provisioned dependencies for hydration or relocated declarations. */
export function ensureRepoNodeModulesLink(
  modulesDir: string,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    symlink = fs.symlinkSync,
    platform = process.platform,
  }: NodeModulesLinkOptions = {},
) {
  const localNodeModules = path.resolve(cwd, "node_modules");
  if (fileExists(localNodeModules)) {
    return localNodeModules;
  }
  if (!fileExists(modulesDir)) {
    return null;
  }
  try {
    // Keep existing checkout dependencies locally owned; only absent modules
    // reuse the selected installed toolchain, without reconciling dependencies.
    symlink(modulesDir, localNodeModules, platform === "win32" ? "junction" : "dir");
  } catch (error) {
    // Another local runner may have installed the same stable link concurrently.
    if (!fileExists(localNodeModules)) {
      throw error;
    }
  }
  return localNodeModules;
}

function hasFlag(args: string[], name: string) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function hasOxlintFormatArg(args: string[]) {
  return args.some(
    (arg) =>
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "-f" ||
      arg.startsWith("-f=") ||
      (arg.startsWith("-f") && arg.length > 2),
  );
}

/** Apply the shared memory and scheduler limits for Go-backed check helpers. */
function applyThrottledGoRuntimeEnv(env: Env, hostResources: Resources) {
  if (!env.GOMAXPROCS) {
    env.GOMAXPROCS = String(
      Math.min(DEFAULT_LOCAL_GO_MAX_PROCS, Math.max(1, hostResources.logicalCpuCount)),
    );
  }
  if (!env.GOGC) {
    env.GOGC = DEFAULT_LOCAL_GO_GC;
  }
  if (!env.GOMEMLIMIT) {
    env.GOMEMLIMIT = DEFAULT_LOCAL_GO_MEMORY_LIMIT;
  }
}

/** Apply local tsgo defaults for declaration skipping, caching, throttling, and profiling. */
export function applyLocalTsgoPolicy(args: string[], env: Env, hostResources: Resources) {
  const nextEnv = { ...env };
  const nextArgs = [...args];
  const defaultProjectRun = nextArgs.length === 0;

  if (!hasFlag(nextArgs, "--declaration") && !nextArgs.includes("-d")) {
    insertBeforeSeparator(nextArgs, "--declaration", "false");
  }

  const localCheckEnabled = isLocalCheckEnabled(nextEnv);
  if (localCheckEnabled && defaultProjectRun) {
    insertBeforeSeparator(nextArgs, "--incremental");
    insertBeforeSeparator(
      nextArgs,
      "--tsBuildInfoFile",
      nextEnv.OPENCLAW_TSGO_BUILD_INFO_FILE ?? DEFAULT_LOCAL_TSGO_BUILD_INFO_FILE,
    );
  }

  const resolvedHostResources = resolveHostResources(hostResources);
  if (
    shouldThrottleLocalChecks(nextEnv, resolvedHostResources, "auto") ||
    (isCiLikeEnv(nextEnv) && isConstrainedCiCheckHost(resolvedHostResources))
  ) {
    insertBeforeSeparator(nextArgs, "--singleThreaded");
    insertBeforeSeparator(nextArgs, "--checkers", "1");
    applyThrottledGoRuntimeEnv(nextEnv, resolvedHostResources);
  }
  if (localCheckEnabled && nextEnv.OPENCLAW_TSGO_PPROF_DIR && !hasFlag(nextArgs, "--pprofDir")) {
    insertBeforeSeparator(nextArgs, "--pprofDir", nextEnv.OPENCLAW_TSGO_PPROF_DIR);
  }

  return { env: nextEnv, args: nextArgs };
}

/** Apply oxlint defaults for type-aware checking and throttled worker settings. */
export function applyLocalOxlintPolicy(args: string[], env: Env, hostResources: Resources) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  insertBeforeSeparator(nextArgs, "--type-aware");
  insertBeforeSeparator(nextArgs, "--tsconfig", "config/tsconfig/oxlint.json");
  if (
    !hasFlag(nextArgs, "--report-unused-disable-directives") &&
    !hasFlag(nextArgs, "--report-unused-disable-directives-severity")
  ) {
    insertBeforeSeparator(nextArgs, "--report-unused-disable-directives-severity", "error");
  }
  if (nextEnv.GITHUB_ACTIONS === "true" && !hasOxlintFormatArg(nextArgs)) {
    insertBeforeSeparator(nextArgs, "--format", "stylish");
  }

  if (
    shouldThrottleLocalChecks(nextEnv, hostResources) ||
    (isCiLikeEnv(nextEnv) && isConstrainedCiCheckHost(hostResources))
  ) {
    if (!hasFlag(nextArgs, "--threads")) {
      insertBeforeSeparator(nextArgs, "--threads=1");
    }
    // Oxlint's thread flag does not govern the Go tsgolint helper.
    applyThrottledGoRuntimeEnv(nextEnv, hostResources);
  }

  return { env: nextEnv, args: nextArgs };
}

function shouldThrottleLocalChecks(
  env: Env,
  hostResources: Resources | undefined,
  defaultMode: LocalCheckMode = "throttled",
) {
  if (!isLocalCheckEnabled(env)) {
    return false;
  }

  const mode = readLocalCheckMode(env, defaultMode);
  if (mode === "throttled") {
    return true;
  }
  if (mode === "full") {
    return false;
  }

  const resolvedHostResources = resolveHostResources(hostResources);
  return (
    resolvedHostResources.totalMemoryBytes < DEFAULT_FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
    resolvedHostResources.logicalCpuCount < DEFAULT_FAST_LOCAL_CHECK_MIN_CPUS
  );
}

function resolveGitCommonDir(cwd: string) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      return path.resolve(cwd, raw);
    }
  }

  return path.join(cwd, ".git");
}

function insertBeforeSeparator(args: string[], ...items: [string, ...string[]]) {
  if (hasFlag(args, items[0])) {
    return;
  }

  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}

function readLocalCheckMode(env: Env, defaultMode: LocalCheckMode) {
  const raw = env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();
  if (raw === "throttled" || raw === "low-memory") {
    return "throttled";
  }
  if (raw === "full" || raw === "fast") {
    return "full";
  }
  return defaultMode;
}

function resolveHostResources(hostResources: Resources | undefined) {
  if (hostResources) {
    return hostResources;
  }

  return {
    totalMemoryBytes: os.totalmem(),
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  };
}
