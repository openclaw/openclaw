#!/usr/bin/env node

// Runs the tsdown build with output cleanup, stale chunk pruning, and bounded
// child-process diagnostics.
import {
  spawn,
  spawnSync,
  type StdioOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { BUNDLED_PLUGIN_BUILD_ENV_NAMES } from "./lib/bundled-plugin-build-entries.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { toErrorObject } from "./lib/error-format.mts";
import {
  inspectManagedProcessGroup,
  signalExitCode,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { readProcessMemoryCapacity, type MemoryLimitParams } from "./lib/process-memory.mts";
import { sanitizeBundlerHelperDtsExportTree } from "./lib/sanitize-bundler-helper-dts-exports.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "./lib/tsdown-config-groups.mts";
import {
  TSDOWN_PACKAGE_OUTPUT_ROOTS,
  tsdownPackageOutputRoot,
} from "./lib/tsdown-output-roots.mts";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const INEFFECTIVE_DYNAMIC_IMPORT_MARKER = "[INEFFECTIVE_DYNAMIC_IMPORT]";
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const DEPENDENCY_PATH_MARKERS = ["node_modules/", "openclaw-pnpm-node-modules/"];
const HASHED_ROOT_JS_RE = /^(?<base>.+)-[A-Za-z0-9_-]+\.js$/u;
const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TSDOWN_MAX_OLD_SPACE_MB = 12288;
const DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB = 8192;
export const TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB";
const DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB";
const TSDOWN_CGROUP_MEMORY_HEADROOM_MB = 768;
const SERIALIZED_MAIN_CONFIG_GROUPS = [
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
];
const tsdownStdio = () => ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"];
// Build descendants get a short cleanup window; a timed-out build must not hold CI for seconds.
const TERMINATION_GRACE_MS = 250;
const POST_FORCE_KILL_WAIT_MS = 250;
const ROOT_TSDOWN_OUTPUT_ROOTS = ["dist", "dist-runtime"];
const PRESERVED_TSDOWN_OUTPUT_FILES = ["dist/cli-startup-metadata.json"];
const PRESERVE_CLI_STARTUP_METADATA_ENV = "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA";
const GENERATED_SOURCE_DECLARATION_PATHSPEC = ":(glob)extensions/**/*.d.ts";
export const TSDOWN_DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SOURCE_DECLARATION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";

const TSDOWN_SOURCE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".json5",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
];

export const TSDOWN_DECLARATION_TOOL_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/tsdown-build.mts",
  "scripts/build-all.mts",
  "scripts/lib/build-artifact-cache.mts",
  "scripts/lib/dist-artifact-ownership.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/repo-root.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/process-memory.mts",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/lib/tsdown-config-groups.mts",
  "scripts/lib/tsdown-declaration-boundary.mts",
  "scripts/lib/tsdown-output-roots.mts",
];
export const TSDOWN_PACKAGES_CACHE_INPUT = {
  path: "packages",
  extensions: TSDOWN_SOURCE_EXTENSIONS,
  excludeDirectories: ["dist", "node_modules"],
};
export const TSDOWN_UNIFIED_CACHE_ENV = [
  "OPENCLAW_BUILD_PRIVATE_QA",
  ...BUNDLED_PLUGIN_BUILD_ENV_NAMES,
];

type OutputRootParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  pathImpl?: Pick<typeof path, "dirname" | "parse" | "resolve">;
  roots?: string[];
};

type ResolvedMemoryLimitParams = MemoryLimitParams & { resolvedMaxOldSpaceMb?: number };

type TsdownBuildParams = ResolvedMemoryLimitParams & {
  args?: string[];
  nodeExecPath?: string;
};

type TsdownBuildResult = ReturnType<ReturnType<typeof createTsdownOutputScanner>["finish"]> & {
  error: Error | null;
  signal: string | null;
  status: number | null;
  timedOut: boolean;
};

type TsdownBuildInvocation = {
  command: string;
  args: string[];
  options: {
    stdio: string[];
    shell: boolean;
    windowsVerbatimArguments?: boolean;
    env: NodeJS.ProcessEnv;
  };
};

function removeDistPluginNodeModulesSymlinks(rootDir: string) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

export function pruneStaleRuntimeSymlinks(params: Pick<OutputRootParams, "cwd" | "fs"> = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const distRoot = path.join(cwd, "dist");
  const distRuntimeRoot = path.join(cwd, "dist-runtime");
  assertRealOutputRoot(distRoot, { fs: fsImpl });
  assertRealOutputRoot(distRuntimeRoot, { fs: fsImpl });
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(distRoot);
  removeDistPluginNodeModulesSymlinks(distRuntimeRoot);
}

/**
 * Removes build output roots while preserving explicitly protected artifacts.
 */
function assertTsdownCleanOutputRoots(params: OutputRootParams = {}) {
  const pathImpl = params.pathImpl ?? path;
  const cwd = pathImpl.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const roots = params.roots ?? listTsdownOutputRoots();
  const rootPaths = roots.map((root) => pathImpl.resolve(cwd, root));
  for (const rootPath of rootPaths) {
    if (pathImpl.parse(rootPath).root === rootPath) {
      throw new Error(
        "Cannot clean a filesystem root. Please specify a dedicated output directory.",
      );
    }
    if (isPathInside(rootPath, cwd)) {
      throw new Error(
        "Cannot clean the current working directory or one of its ancestors. Please specify a dedicated output directory.",
      );
    }
    if (isPathInside(rootPath, resolveDistArtifactLockPath(cwd))) {
      throw new Error("Cannot clean the checkout's dist artifact ownership location.");
    }
    // A safe final component is insufficient: recursive removal follows symlinked parents.
    // Validate every component below the nearest common ancestor before any mutation begins.
    let candidatePath = rootPath;
    while (!isPathInside(candidatePath, cwd)) {
      assertRealOutputRoot(candidatePath, { fs: fsImpl });
      const parentPath = pathImpl.dirname(candidatePath);
      if (parentPath === candidatePath) {
        break;
      }
      candidatePath = parentPath;
    }
  }
  return rootPaths;
}

export function cleanTsdownOutputRoots(params: OutputRootParams = {}) {
  const pathImpl = params.pathImpl ?? path;
  const cwd = pathImpl.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const roots = params.roots ?? listTsdownOutputRoots();
  // Validate the complete mutation set before traversing protected children or
  // cleaning any earlier root; otherwise a later symlink can leave a partial build.
  const rootPaths = assertTsdownCleanOutputRoots({ cwd, fs: fsImpl, pathImpl, roots });
  const protectedDeclarationPaths =
    env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? listExistingGeneratedDeclarationOutputPaths(cwd, fsImpl, roots)
      : new Set<string>();
  const protectedPaths = new Set([
    ...protectedDeclarationPaths,
    ...listExistingPreservedOutputPaths(cwd, env, fsImpl),
  ]);
  for (const rootPath of rootPaths) {
    try {
      if (hasProtectedChild(rootPath, protectedPaths)) {
        cleanOutputRootExcept(rootPath, protectedPaths, fsImpl);
      } else {
        fsImpl.rmSync(rootPath, { force: true, recursive: true });
      }
    } catch {
      // Best-effort cleanup. tsdown will recreate the output tree it needs.
    }
  }
}

function hasProtectedChild(rootPath: string, protectedPaths: Set<string>) {
  const rootWithSeparator = `${path.resolve(rootPath)}${path.sep}`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(rootWithSeparator)) {
      return true;
    }
  }
  return false;
}

function cleanOutputRootExcept(rootPath: string, protectedPaths: Set<string>, fsImpl: typeof fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const resolvedEntryPath = path.resolve(entryPath);
    if (protectedPaths.has(resolvedEntryPath)) {
      continue;
    }
    try {
      if (entry.isDirectory()) {
        cleanOutputRootExcept(entryPath, protectedPaths, fsImpl);
        fsImpl.rmdirSync(entryPath);
      } else {
        fsImpl.rmSync(entryPath, { force: true });
      }
    } catch {
      // Keep best-effort semantics; protected children can keep a directory non-empty.
    }
  }
}

function listExistingGeneratedDeclarationOutputPaths(
  cwd: string,
  fsImpl: typeof fs,
  roots: string[],
) {
  const protectedPaths = new Set<string>();
  for (const root of roots) {
    collectDeclarationOutputPaths(path.resolve(cwd, root), protectedPaths, fsImpl);
  }
  return protectedPaths;
}

function listExistingPreservedOutputPaths(cwd: string, env: NodeJS.ProcessEnv, fsImpl: typeof fs) {
  // Vite owns and cleans this subtree; tsdown cannot recreate its assets.
  const protectedPaths = new Set([path.resolve(cwd, "dist/control-ui")]);
  // Mac packaging owns replacement of signed bundles. Rebuilding its JS must
  // leave the previous app (including its private runtime) usable on failure.
  const pendingDirectories = [path.join(cwd, "dist")];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    if (!fsImpl.existsSync(directory)) {
      continue;
    }
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) {
        protectedPaths.add(child);
      } else {
        pendingDirectories.push(child);
      }
    }
  }
  if (env[PRESERVE_CLI_STARTUP_METADATA_ENV] !== "1") {
    return protectedPaths;
  }
  for (const relativePath of PRESERVED_TSDOWN_OUTPUT_FILES) {
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      if (fsImpl.statSync(absolutePath).isFile()) {
        protectedPaths.add(absolutePath);
      }
    } catch {
      // Missing preserved outputs are normal on first build.
    }
  }
  return protectedPaths;
}

/** Publish generated declarations without claiming runtime assets or protected subtrees. */
export function listReplaceableTsdownDeclarationOutputs(params: OutputRootParams = {}) {
  const cwd = path.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const roots = params.roots ?? listTsdownOutputRoots();
  assertTsdownCleanOutputRoots({ ...params, cwd, fs: fsImpl, roots });
  const protectedPaths = [
    ...listExistingPreservedOutputPaths(cwd, params.env ?? process.env, fsImpl),
  ];
  return [...listExistingGeneratedDeclarationOutputPaths(cwd, fsImpl, roots)]
    .filter(
      (file) =>
        !protectedPaths.some(
          (protectedPath) =>
            file === protectedPath || file.startsWith(`${protectedPath}${path.sep}`),
        ),
    )
    .toSorted();
}

function collectDeclarationOutputPaths(
  rootPath: string,
  protectedPaths: Set<string>,
  fsImpl: typeof fs,
) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectDeclarationOutputPaths(entryPath, protectedPaths, fsImpl);
    } else if (TSDOWN_DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      protectedPaths.add(path.resolve(entryPath));
    }
  }
}

export function pruneStaleRootChunkFiles(params: Pick<OutputRootParams, "cwd" | "fs"> = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const roots = listTsdownOutputRoots().map((root) => path.join(cwd, root));
  for (const root of roots) {
    assertRealOutputRoot(root, { fs: fsImpl });
  }
  for (const root of roots) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!HASHED_ROOT_JS_RE.test(entry.name)) {
        continue;
      }
      try {
        fsImpl.rmSync(path.join(root, entry.name), { force: true });
      } catch {
        // Best-effort cleanup. The subsequent build will overwrite any stragglers.
      }
    }
  }
}

export function listTsdownOutputRoots() {
  return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...TSDOWN_PACKAGE_OUTPUT_ROOTS];
}

function readForwardedOptions(args: string[], names: string[]) {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error(`tsdown build requires one concrete ${names.join("/")} value`);
        }
        values.push(value);
      } else if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (!value) {
          throw new Error(`tsdown build requires one concrete ${names.join("/")} value`);
        }
        values.push(value);
      }
    }
  }
  return values;
}
const readForwardedOption = (args: string[], names: string[]) =>
  readForwardedOptions(args, names)[0];
function readForwardedScalarOption(args: string[], names: string[], label: string) {
  const values = readForwardedOptions(args, names);
  if (values.length > 1) {
    throw new Error(`tsdown build accepts only one ${label} value`);
  }
  return values[0];
}
const isFilterFlag = (arg: string | undefined) => arg === "--filter" || arg === "-F";
const isFilterArg = (arg: string) =>
  isFilterFlag(arg) || arg.startsWith("--filter=") || arg.startsWith("-F=");
const isConfigArg = (arg: string) =>
  arg === "--config" ||
  arg.startsWith("--config=") ||
  arg === "-c" ||
  arg.startsWith("-c=") ||
  arg === "--no-config";
const isWatchArg = (arg: string) =>
  arg === "--watch" || arg.startsWith("--watch=") || arg === "-w" || arg.startsWith("-w=");
const isUnifiedDtsGroup = (value: string | undefined) =>
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.some((group) => group === value);

/** Limits cleanup to the output roots owned by an explicitly filtered build. */
export function resolveTsdownCleanOutputRoots(args: string[] = []) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  const outDir = readForwardedScalarOption(args, ["--out-dir", "-d"], "--out-dir/-d");
  const filters = readForwardedOptions(args, ["--filter", "-F"]);
  const configPath = config ? path.resolve(config) : undefined;
  const aiConfigPath = path.resolve("tsdown.ai.config.ts");
  const aiRoot = tsdownPackageOutputRoot("ai");
  const packageRoots = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter((root) => root !== aiRoot);
  const selectsRootCwd = filters.includes(".");
  const selectedMainRoots = [
    ...(filters.includes(TSDOWN_PACKAGE_CONFIG_GROUP) ? packageRoots : []),
    ...(filters.some(
      (filter) => filter === TSDOWN_UNIFIED_CONFIG_GROUP || isUnifiedDtsGroup(filter),
    )
      ? ROOT_TSDOWN_OUTPUT_ROOTS
      : []),
  ];

  if (outDir !== undefined) {
    return [outDir];
  }
  if (configPath === aiConfigPath) {
    return [aiRoot];
  }
  if (selectsMainConfig(args)) {
    return filters.length === 0 || selectsRootCwd || selectedMainRoots.length === 0
      ? [...ROOT_TSDOWN_OUTPUT_ROOTS, ...packageRoots]
      : selectedMainRoots;
  }
  if (!config && selectsRootCwd) {
    return listTsdownOutputRoots();
  }
  if (!config && filters.length > 0 && selectedMainRoots.length > 0) {
    return [aiRoot, ...selectedMainRoots];
  }
  return listTsdownOutputRoots();
}

export function sanitizeTsdownBuildOutputRoots(args: string[] = [], cwd = process.cwd()): void {
  const roots = resolveTsdownCleanOutputRoots(args);
  const rootPaths = assertTsdownCleanOutputRoots({ cwd, roots });
  for (const rootPath of rootPaths) {
    sanitizeBundlerHelperDtsExportTree(rootPath);
  }
}

function wrapperOwnsTsdownCleanup(args: string[]) {
  if (readForwardedScalarOption(args, ["--out-dir", "-d"], "--out-dir/-d") !== undefined) {
    return true;
  }
  const config = readForwardedOption(args, ["--config", "-c"]);
  if (config === undefined) {
    return true;
  }
  return path.resolve(config) === path.resolve("tsdown.ai.config.ts") || selectsMainConfig(args);
}

type GitLsFilesResult = Pick<SpawnSyncReturns<string>, "status"> & { stdout?: string };

export function pruneUntrackedGeneratedSourceDeclarations(
  params: {
    cwd?: string;
    fs?: typeof fs;
    spawnSync?: (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => GitLsFilesResult;
  } = {},
) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  let result;
  try {
    result = spawnSyncImpl(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", GENERATED_SOURCE_DECLARATION_PATHSPEC],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return 0;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return 0;
  }

  let removed = 0;
  for (const rawPath of result.stdout.split(/\r?\n/u)) {
    const relativePath = rawPath.trim().replaceAll("\\", "/");
    if (!relativePath.startsWith("extensions/") || !relativePath.endsWith(".d.ts")) {
      continue;
    }
    const declarationPath = path.join(cwd, relativePath);
    const sourceBase = declarationPath.slice(0, -".d.ts".length);
    const hasMatchingSource = SOURCE_DECLARATION_SOURCE_EXTENSIONS.some((extension) =>
      fsImpl.existsSync(`${sourceBase}${extension}`),
    );
    if (!hasMatchingSource) {
      continue;
    }
    try {
      fsImpl.rmSync(declarationPath, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup; tsdown will still report any remaining stale files.
    }
  }
  return removed;
}

function findFatalUnresolvedImport(lines: string[]) {
  for (const line of lines) {
    if (!line.includes("[UNRESOLVED_IMPORT]")) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !DEPENDENCY_PATH_MARKERS.some((marker) => normalizedLine.includes(marker))
    ) {
      return normalizedLine;
    }
  }

  return null;
}

function parsePositiveIntegerEnv(value: string | undefined, name: string) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return parsePositiveInt(value, name);
}

function parseNonNegativeIntegerEnv(value: string | undefined, name: string) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const text = value.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function resolveTsdownMemoryBudget(params: ResolvedMemoryLimitParams = {}) {
  if (params.resolvedMaxOldSpaceMb !== undefined) {
    return { maxOldSpaceMb: params.resolvedMaxOldSpaceMb, unresolvedCgroupMemory: false };
  }
  const defaultMaxOldSpaceMb =
    (params.platform ?? process.platform) === "win32"
      ? DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB
      : DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
  const envOverride = parsePositiveIntegerEnv(
    (params.env ?? process.env)[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  if (envOverride !== null) {
    return { maxOldSpaceMb: envOverride, unresolvedCgroupMemory: false };
  }
  const { limitBytes, unresolved } = readProcessMemoryCapacity(params);
  if (unresolved) {
    return { maxOldSpaceMb: 1, unresolvedCgroupMemory: true };
  }
  if (limitBytes === null) {
    return { maxOldSpaceMb: defaultMaxOldSpaceMb, unresolvedCgroupMemory: false };
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  // Never exceed the budget just discovered: a floor applied on top of a real limit produces
  // a heap the cgroup cannot honour, which is an OOM kill rather than a smaller build.
  const cgroupCap = Math.max(1, limitMb - TSDOWN_CGROUP_MEMORY_HEADROOM_MB);
  return {
    maxOldSpaceMb: Math.min(defaultMaxOldSpaceMb, cgroupCap),
    unresolvedCgroupMemory: false,
  };
}

/** Independently staged misses may overlap within the two largest compiler budgets. */
export function resolveStagedDeclarationConcurrency(
  groups: readonly { name: string; maxOldSpaceMb: number }[],
  params: MemoryLimitParams & { availableParallelism?: number } = {},
): 1 | 2 {
  if (
    groups.length < 2 ||
    groups.some((group) => !isUnifiedDtsGroup(group.name)) ||
    new Set(groups.map((group) => group.name)).size !== groups.length ||
    (params.availableParallelism ?? os.availableParallelism()) < 2
  ) {
    return 1;
  }
  // Frozen or explicit per-child heaps do not establish available batch capacity.
  // Unknown available memory stays serial; retain native headroom for each child.
  const capacity = readProcessMemoryCapacity(params);
  const requiredBytes = groups
    .map((group) => group.maxOldSpaceMb)
    .toSorted((left, right) => right - left)
    .slice(0, 2)
    .reduce((sum, heap) => sum + (heap + TSDOWN_CGROUP_MEMORY_HEADROOM_MB) * 1024 * 1024, 0);
  return !capacity.unresolved &&
    capacity.usageKnown &&
    capacity.availableBytes !== null &&
    capacity.limitBytes !== null &&
    capacity.limitBytes >= requiredBytes
    ? 2
    : 1;
}

const resolveTsdownMaxOldSpaceMb = (params: ResolvedMemoryLimitParams = {}) =>
  resolveTsdownMemoryBudget(params).maxOldSpaceMb;

/**
 * Measured against this repo by running the full eleven-invocation build inside real cgroups.
 * A 5GiB slice resolves this heap, completes, and peaks at 4730MiB. A 4GiB slice (3328MB heap)
 * and a 2816MiB slice (2048MB heap) are both killed in the third, unified-runtime invocation,
 * which also runs when declarations are disabled. Roughly 380MiB of the peak is rolldown, a
 * native addon which --max-old-space-size does not govern at all.
 */
const MEASURED_MIN_TSDOWN_HEAP_MB = 4352;

/**
 * Describes a host that cannot fit the build, or null when it can. Reported before any
 * output is cleaned: a host that cannot rebuild must not also lose the build it already
 * has. Fatal by default because continuing either aborts partway through the invocation
 * list or, when the heap outruns a container limit, thrashes at the ceiling instead of
 * failing, which starves every other process on the machine.
 */
export function describeInsufficientTsdownHeap(
  params: ResolvedMemoryLimitParams = {},
  budget = resolveTsdownMemoryBudget(params),
) {
  const { maxOldSpaceMb } = budget;
  if (maxOldSpaceMb >= MEASURED_MIN_TSDOWN_HEAP_MB) {
    return null;
  }
  const env = params.env ?? process.env;
  const explicitHeapMb = parsePositiveIntegerEnv(
    env[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  const heapOverrideEnv = Object.hasOwn(env, "OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS")
    ? DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV
    : TSDOWN_MAX_OLD_SPACE_MB_ENV;
  const fatal = explicitHeapMb === null;
  const outcome = fatal
    ? budget.unresolvedCgroupMemory
      ? [
          "Stopping before any build output is removed. Pick one:",
          "  - run the build where the process cgroup limit is visible",
          `  - set ${heapOverrideEnv}=<MB> to explicitly attempt the build anyway`,
        ]
      : [
          "Stopping before any build output is removed. Pick one:",
          "  - give this machine or container more memory",
          `  - set ${heapOverrideEnv}=<MB> to explicitly attempt the build anyway`,
        ]
    : [
        `Continuing because ${heapOverrideEnv} explicitly requests ${explicitHeapMb}MB. Existing build output will now be cleaned; the build may stall or fail.`,
      ];
  return {
    fatal,
    message: [
      budget.unresolvedCgroupMemory
        ? "[tsdown-build] The process memory limit is not visible through this cgroup mount namespace, so OpenClaw cannot choose a safe default heap."
        : `[tsdown-build] The resolved OpenClaw build heap is ${maxOldSpaceMb}MB, ` +
          `and a full build needs ${MEASURED_MIN_TSDOWN_HEAP_MB}MB, peaking near 4.7GB once rolldown's ` +
          `native allocations are counted; those are not covered by --max-old-space-size.`,
      ...outcome,
    ].join("\n"),
  };
}

function parseMaxOldSpaceSizeMb(value: unknown, fallbackMb: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb;
  }
  return Math.trunc(parsed);
}

function normalizeMaxOldSpaceSizeMb(value: unknown, maxOldSpaceMb: number) {
  // Build wrappers may inherit smaller runner-level caps; tsdown needs the
  // resolved build heap while still respecting cgroup-derived upper bounds.
  const parsed = parseMaxOldSpaceSizeMb(value, maxOldSpaceMb);
  if (parsed < maxOldSpaceMb) {
    return maxOldSpaceMb;
  }
  return Math.min(parsed, maxOldSpaceMb);
}

function normalizeTsdownNodeOptions(nodeOptions: string, params: ResolvedMemoryLimitParams = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  const parts = nodeOptions.trim().split(/\s+/u).filter(Boolean);
  const normalized: string[] = [];
  let foundMaxOldSpaceSize = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }
    const inlineMatch = part.match(/^--max-old-space-size=(\d+)$/u);
    if (inlineMatch) {
      foundMaxOldSpaceSize = true;
      const value = normalizeMaxOldSpaceSizeMb(inlineMatch[1], maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      continue;
    }

    if (part === "--max-old-space-size") {
      foundMaxOldSpaceSize = true;
      const next = parts[index + 1];
      const value = normalizeMaxOldSpaceSizeMb(next, maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      if (next !== undefined) {
        index += 1;
      }
      continue;
    }

    normalized.push(part);
  }

  if (!foundMaxOldSpaceSize) {
    normalized.push(`--max-old-space-size=${maxOldSpaceMb}`);
  }

  return normalized.join(" ");
}

function resolveTsdownEnv(
  env: NodeJS.ProcessEnv,
  params: ResolvedMemoryLimitParams = {},
): NodeJS.ProcessEnv {
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  return {
    ...env,
    NODE_OPTIONS: normalizeTsdownNodeOptions(nodeOptions, params),
  };
}

function tsdownBuildUsage() {
  return [
    "Usage: node --import tsx scripts/tsdown-build.mts [tsdown args...]",
    "",
    "Builds OpenClaw with tsdown and validates emitted import diagnostics.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting tsdown.",
    "",
    "Other arguments are forwarded to tsdown.",
  ].join("\n");
}

export function parseTsdownBuildArgs(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      forwardedArgs: [],
      help: true,
    };
  }
  return {
    forwardedArgs: argv,
    help: false,
  };
}

export function createTsdownOutputScanner(params: { maxCaptureBytes?: number } = {}) {
  const maxCaptureBytes = params.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  let captured = "";
  let pendingLine = "";
  let hasIneffectiveDynamicImport = false;
  let fatalUnresolvedImport: string | null = null;

  function scanLines(text: string) {
    const combined = pendingLine + text;
    const lines = combined.split(/\r?\n/u);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      fatalUnresolvedImport ??= findFatalUnresolvedImport([line]);
    }
  }

  return {
    append(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(INEFFECTIVE_DYNAMIC_IMPORT_MARKER)) {
        hasIneffectiveDynamicImport = true;
      }
      scanLines(text);
      captured += text;
      if (captured.length > maxCaptureBytes) {
        captured = captured.slice(-maxCaptureBytes);
      }
    },
    finish() {
      if (pendingLine) {
        fatalUnresolvedImport ??= findFatalUnresolvedImport([pendingLine]);
        pendingLine = "";
      }
      return {
        captured,
        hasIneffectiveDynamicImport,
        fatalUnresolvedImport,
      };
    },
  };
}

export function resolveTsdownBuildInvocation(
  params: TsdownBuildParams = {},
): TsdownBuildInvocation {
  const env = resolveTsdownEnv(params.env ?? process.env, params);
  const args = params.args ?? [];
  const forwardedArgs = wrapperOwnsTsdownCleanup(args)
    ? args.filter((arg) => arg !== "--clean" && !arg.startsWith("--clean="))
    : args;
  const explicitConcurrency = args.some(
    (arg) => arg === "--concurrency" || arg.startsWith("--concurrency="),
  );
  const filters = readForwardedOptions(args, ["--filter", "-F"]);
  const runtimeOnly =
    !args.includes("--dts") &&
    (!args.some(isConfigArg) || selectsMainConfig(args)) &&
    filters.length > 0 &&
    filters.every((filter) => filter === TSDOWN_UNIFIED_CONFIG_GROUP);
  const tsdownArgs = [
    "--config-loader",
    "unrun",
    "--logLevel",
    logLevel,
    "--no-clean",
    // Native declaration children retain entire compiler graphs. Let tsdown own
    // config admission so preparation and trace drainage cannot overlap unboundedly.
    ...(!explicitConcurrency && !runtimeOnly && tsdownDeclarationsEnabled(args, env)
      ? ["--concurrency", "1"]
      : []),
    ...forwardedArgs,
  ];
  // A package-manager bin shim can select a different runtime from PATH.
  // Keep the compiler on the runtime chosen by its build owner.
  return {
    command: params.nodeExecPath ?? process.execPath,
    args: ["node_modules/tsdown/dist/run.mjs", ...tsdownArgs],
    options: {
      stdio: tsdownStdio(),
      shell: false,
      windowsVerbatimArguments: undefined,
      env,
    },
  };
}

function tsdownDeclarationsEnabled(args: string[], env: NodeJS.ProcessEnv) {
  const dtsArg = args.findLast((arg) => arg === "--dts" || arg === "--no-dts");
  return dtsArg ? dtsArg === "--dts" : env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1";
}

function selectsMainConfig(args: string[]) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  if (config === undefined) {
    return false;
  }
  const resolvedConfig = path.resolve(config);
  const mainConfig = path.resolve("tsdown.config.ts");
  return resolvedConfig === mainConfig || resolvedConfig === path.dirname(mainConfig);
}

function resolveSerializedMainConfigGroups(filters: string[]) {
  const uniqueFilters = [...new Set(filters)];
  if (filters.length === 0 || filters.includes(".")) {
    return SERIALIZED_MAIN_CONFIG_GROUPS;
  }
  if (
    uniqueFilters.some(
      (filter) => filter !== "." && !SERIALIZED_MAIN_CONFIG_GROUPS.includes(filter),
    )
  ) {
    return null;
  }
  if (filters.includes(TSDOWN_UNIFIED_CONFIG_GROUP) && !filters.some(isUnifiedDtsGroup)) {
    return filters.includes(TSDOWN_PACKAGE_CONFIG_GROUP)
      ? SERIALIZED_MAIN_CONFIG_GROUPS
      : SERIALIZED_MAIN_CONFIG_GROUPS.slice(1);
  }
  if (uniqueFilters.length < 2) {
    return null;
  }
  const selectedFilters = new Set(uniqueFilters);
  return SERIALIZED_MAIN_CONFIG_GROUPS.filter((group) => selectedFilters.has(group));
}

/** Builds declarations in dependency order without overlapping the largest graphs. */
export function resolveTsdownBuildInvocations(params: TsdownBuildParams = {}) {
  const forwardedArgs = params.args ?? [];
  readForwardedScalarOption(forwardedArgs, ["--out-dir", "-d"], "--out-dir/-d");
  if (forwardedArgs.filter(isConfigArg).length > 1) {
    throw new Error("tsdown build accepts only one --config/-c/--no-config selector");
  }
  const env = params.env ?? process.env;
  const forwardedFilters = readForwardedOptions(forwardedArgs, ["--filter", "-F"]);
  const hasForwardedFilter = forwardedArgs.some(isFilterArg);
  const aiArgs = forwardedArgs.filter((arg, index) => {
    const previous = forwardedArgs[index - 1];
    return !isFilterArg(arg) && !isFilterFlag(previous);
  });
  const declarationsEnabled = tsdownDeclarationsEnabled(aiArgs, env);
  const hasForwardedConfig = aiArgs.some(isConfigArg);

  const declarationEnv =
    declarationsEnabled && env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? { ...env, [RUN_NODE_SKIP_DTS_BUILD_ENV]: "0" }
      : env;

  if (forwardedArgs.some(isWatchArg)) {
    if (!hasForwardedConfig) {
      throw new Error(
        "tsdown build watch mode requires an explicit --config/-c or --no-config selector. Run separate watchers for tsdown.config.ts and tsdown.ai.config.ts to watch both graphs.",
      );
    }
    // Watchers are long-lived, so sequential group orchestration would block forever on the
    // first child. Keep watch mode inside tsdown's single owning process.
    return [resolveTsdownBuildInvocation(params)];
  }

  if (hasForwardedConfig) {
    if (declarationsEnabled && selectsMainConfig(forwardedArgs)) {
      const serializedGroups = resolveSerializedMainConfigGroups(forwardedFilters);
      if (serializedGroups) {
        return serializedGroups.map((group) =>
          resolveTsdownBuildInvocation({
            ...params,
            args: ["--filter", group, ...aiArgs],
            env: declarationEnv,
          }),
        );
      }
    }
    return [resolveTsdownBuildInvocation(params)];
  }

  const invocations = [
    resolveTsdownBuildInvocation({
      ...params,
      args: ["--config", "tsdown.ai.config.ts", ...aiArgs],
    }),
  ];

  const forwardedFilterSet = new Set(forwardedFilters);
  const uniqueForwardedFilters = SERIALIZED_MAIN_CONFIG_GROUPS.filter((group) =>
    forwardedFilterSet.has(group),
  );
  const hasUnknownFilter = forwardedFilters.some(
    (filter) => filter !== "." && !SERIALIZED_MAIN_CONFIG_GROUPS.includes(filter),
  );
  const serializedGroups = forwardedFilters.includes(".")
    ? SERIALIZED_MAIN_CONFIG_GROUPS
    : !hasUnknownFilter && uniqueForwardedFilters.length > 1
      ? uniqueForwardedFilters
      : null;
  if (!declarationsEnabled || (hasForwardedFilter && !serializedGroups)) {
    const mainEnv =
      !declarationsEnabled && env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1"
        ? { ...env, [RUN_NODE_SKIP_DTS_BUILD_ENV]: "1" }
        : env;
    invocations.push(resolveTsdownBuildInvocation({ ...params, env: mainEnv }));
    return invocations;
  }

  for (const group of serializedGroups ?? SERIALIZED_MAIN_CONFIG_GROUPS) {
    invocations.push(
      resolveTsdownBuildInvocation({
        ...params,
        args: ["--filter", group, ...aiArgs],
        env: declarationEnv,
      }),
    );
  }
  return invocations;
}

function isFullTsdownBuildPlan(args: string[]) {
  const filters = readForwardedOptions(args, ["--filter", "-F"]);
  const selectsUnifiedRuntime =
    filters.length === 0 || filters.includes(TSDOWN_UNIFIED_CONFIG_GROUP) || filters.includes(".");
  return selectsUnifiedRuntime && (!args.some(isConfigArg) || selectsMainConfig(args));
}

export function resolveTsdownBuildPlan(params: TsdownBuildParams = {}) {
  const budget = resolveTsdownMemoryBudget(params);
  const maxOldSpaceMb = budget.maxOldSpaceMb;
  const preparedParams = {
    ...params,
    resolvedMaxOldSpaceMb: maxOldSpaceMb,
  };
  return {
    env: resolveTsdownEnv(params.env ?? process.env, preparedParams),
    maxOldSpaceMb,
    heapShortfall:
      budget.unresolvedCgroupMemory || isFullTsdownBuildPlan(params.args ?? [])
        ? describeInsufficientTsdownHeap(preparedParams, budget)
        : null,
    invocations: resolveTsdownBuildInvocations(preparedParams),
  };
}

export function prepareTsdownBuildExecution(
  params: TsdownBuildParams = {},
  hooks: {
    cleanup?: (args: string[]) => void;
    reportShortfall?: (
      shortfall: NonNullable<ReturnType<typeof describeInsufficientTsdownHeap>>,
    ) => void;
  } = {},
) {
  const args = params.args ?? [];
  const plan = resolveTsdownBuildPlan(params);
  if (plan.heapShortfall) {
    hooks.reportShortfall?.(plan.heapShortfall);
    if (plan.heapShortfall.fatal) {
      return null;
    }
  }
  const cleanup =
    hooks.cleanup ??
    ((forwardedArgs: string[]) => {
      const roots = resolveTsdownCleanOutputRoots(forwardedArgs);
      // Reject unsafe custom output roots before any preparatory mutation. The second
      // validation in cleanTsdownOutputRoots closes a symlink race before deletion.
      assertTsdownCleanOutputRoots({ roots });
      pruneUntrackedGeneratedSourceDeclarations();
      pruneStaleRuntimeSymlinks();
      cleanTsdownOutputRoots({ roots });
    });
  cleanup(args);
  return plan;
}

type TaskkillRunner = (
  command: string,
  args: string[],
  options: { killSignal?: NodeJS.Signals; stdio?: StdioOptions; timeout?: number },
) => { error?: Error; status: number | null };

export async function runTsdownBuildInvocation(
  invocation: TsdownBuildInvocation,
  params: {
    stdout?: { write(chunk: unknown): unknown };
    stderr?: { write(chunk: unknown): unknown };
    env?: NodeJS.ProcessEnv;
    scanner?: ReturnType<typeof createTsdownOutputScanner>;
    platform?: NodeJS.Platform;
    runTaskkill?: TaskkillRunner;
  } = {},
): Promise<TsdownBuildResult> {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;
  const env = params.env ?? process.env;
  const scanner = params.scanner ?? createTsdownOutputScanner();
  const timeoutMs = parsePositiveIntegerEnv(
    env.OPENCLAW_TSDOWN_TIMEOUT_MS,
    "OPENCLAW_TSDOWN_TIMEOUT_MS",
  );
  const heartbeatMs =
    parseNonNegativeIntegerEnv(env.OPENCLAW_TSDOWN_HEARTBEAT_MS, "OPENCLAW_TSDOWN_HEARTBEAT_MS") ??
    DEFAULT_HEARTBEAT_MS;
  let timedOut = false;
  let parentSignal: NodeJS.Signals | undefined;
  let settled = false;
  let lastOutputAt = Date.now();
  let forceKillAt: number | null = null;

  const platform = params.platform ?? process.platform;
  const runTaskkill = params.runTaskkill ?? spawnSync;
  const useProcessGroup = platform !== "win32";
  const [stdin, stdoutPipe, stderrPipe] = invocation.options.stdio;
  if (stdin !== "ignore" || stdoutPipe !== "pipe" || stderrPipe !== "pipe") {
    throw new Error("tsdown invocation stdio must be ignore/pipe/pipe");
  }
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options,
    stdio: tsdownStdio(),
    detached: useProcessGroup,
  });
  const pidText = child.pid ? ` pid=${child.pid}` : "";

  function markOutput() {
    lastOutputAt = Date.now();
  }

  function signalChild(signal: NodeJS.Signals) {
    terminateManagedChild(child, signal, {
      platform,
      runTaskkill,
      useProcessGroup,
    });
  }

  const parentSignalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  function cleanupParentSignalHandlers() {
    for (const { signal, handler } of parentSignalHandlers) {
      process.off(signal, handler);
    }
    parentSignalHandlers.length = 0;
  }

  function relayParentSignal(signal: NodeJS.Signals) {
    const handler = () => {
      parentSignal ??= signal;
      signalChild(signal);
      signalChild("SIGKILL");
    };
    parentSignalHandlers.push({ signal, handler });
    process.once(signal, handler);
  }

  if (useProcessGroup) {
    relayParentSignal("SIGINT");
    relayParentSignal("SIGTERM");
    relayParentSignal("SIGHUP");
  }

  let observedProcessState: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  const processTreeAlive = () => {
    observedProcessState = inspectManagedProcessGroup(child, {
      errorPolicy: "alive-on-eperm",
      inspectLeaderWhenNoGroup: true,
      platform,
    });
    return observedProcessState === "live";
  };
  const waitForProcessTreeExit = (timeoutMsToWait: number) =>
    waitForManagedProcessGroupExit(child, timeoutMsToWait, {
      errorPolicy: "alive-on-eperm",
      inspectLeaderWhenNoGroup: true,
      platform,
    });

  async function finishTimedOutProcessTree() {
    const graceRemainingMs =
      forceKillAt === null ? TERMINATION_GRACE_MS : Math.max(0, forceKillAt - Date.now());
    if (graceRemainingMs > 0) {
      await waitForProcessTreeExit(graceRemainingMs);
    }
    if (processTreeAlive()) {
      signalChild("SIGKILL");
      await waitForProcessTreeExit(POST_FORCE_KILL_WAIT_MS);
    }
  }

  child.stdout?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stderr.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (settled) {
            return;
          }
          const silentForMs = Date.now() - lastOutputAt;
          if (silentForMs < heartbeatMs) {
            return;
          }
          stderr.write(
            `[tsdown-build] still running${pidText}; no output for ${Math.round(
              silentForMs / 1000,
            )}s\n`,
          );
          lastOutputAt = Date.now();
        }, heartbeatMs).unref()
      : null;

  const timeout =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true;
          stderr.write(`[tsdown-build] timeout after ${timeoutMs}ms${pidText}; sending SIGTERM\n`);
          signalChild("SIGTERM");
          forceKillAt = Date.now() + TERMINATION_GRACE_MS;
          setTimeout(() => {
            if (!settled) {
              stderr.write(`[tsdown-build] forcing SIGKILL${pidText}\n`);
              signalChild("SIGKILL");
            }
          }, TERMINATION_GRACE_MS).unref();
        }, timeoutMs).unref()
      : null;

  return new Promise<TsdownBuildResult>((resolve) => {
    child.once("error", (error) => {
      settled = true;
      cleanupParentSignalHandlers();
      clearInterval(heartbeat ?? undefined);
      clearTimeout(timeout ?? undefined);
      stderr.write(`[tsdown-build] failed to start: ${String(error)}\n`);
      resolve({
        status: 1,
        signal: null,
        timedOut,
        error,
        ...scanner.finish(),
      });
    });
    child.once("close", (status, signal) => {
      let exitStatus = status;
      let cleanup = parentSignal ? "parent-signal" : timedOut ? "timeout" : "none";
      const reportFailure = (finalStatus: number | null) => {
        // Cleanup can reject a successful compiler. Preserve both outcomes so a
        // failed build does not look like a compiler error with missing output.
        stderr.write(
          `[tsdown-build] child result${pidText}: ${JSON.stringify({
            status,
            signal,
            parentSignal: parentSignal ?? null,
            timedOut,
            cleanup,
            observedProcessState: observedProcessState ?? "not-observed",
            observationScope: useProcessGroup ? "process-group" : "leader",
            finalStatus,
          })}\n`,
        );
      };
      function finish() {
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat ?? undefined);
        clearTimeout(timeout ?? undefined);
        const finalStatus = parentSignal ? signalExitCode(parentSignal) : exitStatus;
        if (finalStatus !== 0 || timedOut) {
          reportFailure(finalStatus);
        }
        resolve({
          status: finalStatus,
          signal: parentSignal ?? signal,
          timedOut,
          error: null,
          ...scanner.finish(),
        });
      }

      void (async () => {
        if (timedOut || parentSignal) {
          await finishTimedOutProcessTree();
        } else if (processTreeAlive()) {
          cleanup = "remaining-descendants";
          signalChild("SIGKILL");
          await waitForProcessTreeExit(POST_FORCE_KILL_WAIT_MS);
          exitStatus = 1;
        }
        if (processTreeAlive()) {
          // Keep ownership when the group could still mutate output after close.
          throw Object.assign(new Error("tsdown process group did not exit"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "live",
          });
        }
        finish();
      })().catch((error: unknown) => {
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat ?? undefined);
        clearTimeout(timeout ?? undefined);
        reportFailure(1);
        resolve({
          status: 1,
          signal,
          timedOut,
          error: toErrorObject(error, "tsdown cleanup failed"),
          ...scanner.finish(),
        });
      });
    });
  });
}

async function executeTsdownInvocation(
  invocation: TsdownBuildInvocation,
  index: number,
  count: number,
): Promise<number> {
  const startedAt = performance.now();
  const result = await runTsdownBuildInvocation(invocation);
  if (result.error) {
    throw result.error;
  }
  console.log(
    `[tsdown-build] invocation ${index + 1}/${count} finished in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (result.status === 0 && result.hasIneffectiveDynamicImport) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    return 1;
  }

  if (result.status === 0 && result.fatalUnresolvedImport) {
    console.error(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${result.fatalUnresolvedImport}`,
    );
    return 1;
  }

  if (result.timedOut) {
    return 124;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return 1;
}

/** Execute CLI and staged declaration plans with the same diagnostics and deadlines. */
export async function executeTsdownBuildPlan(
  plan: NonNullable<ReturnType<typeof prepareTsdownBuildExecution>>,
  concurrency: 1 | 2 = 1,
) {
  let next = 0;
  let exitCode = plan.invocations.length ? 0 : 1;
  const failedExits: { index: number; code: number }[] = [];
  const run = async () => {
    while (exitCode === 0 && next < plan.invocations.length) {
      const index = next++;
      try {
        const code = await executeTsdownInvocation(
          plan.invocations[index]!,
          index,
          plan.invocations.length,
        );
        if (code !== 0) {
          failedExits.push({ index, code });
          exitCode ||= code;
        }
      } catch (error) {
        exitCode ||= 1;
        throw error;
      }
    }
  };
  // A failed sibling stops admission, not the lifetime of an already admitted compiler.
  // Join every result before the writer may seal, publish, or release its private stages.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, plan.invocations.length) }, run),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length || failedExits.length > 1) {
    failures.push(
      ...failedExits.map(({ index, code }) =>
        Object.assign(new Error(`tsdown invocation ${index + 1} failed with exit ${code}`), {
          exitCode: code,
        }),
      ),
    );
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "tsdown compiler batch failed");
  }
  return exitCode;
}

export async function runTsdownBuild(
  argv: string[] = process.argv.slice(2),
  options: {
    cwd?: string;
    executeBuild?: (forwardedArgs: string[]) => Promise<number>;
  } = {},
): Promise<number> {
  const args = parseTsdownBuildArgs(argv);
  if (args.help) {
    console.log(tsdownBuildUsage());
    return 0;
  }
  let code: number;
  if (options.executeBuild) {
    code = await options.executeBuild(args.forwardedArgs);
  } else {
    const plan = prepareTsdownBuildExecution(
      { args: args.forwardedArgs },
      {
        reportShortfall(shortfall) {
          if (shortfall.fatal) {
            console.error(shortfall.message);
          } else {
            console.warn(shortfall.message);
          }
        },
      },
    );
    if (!plan) {
      return 1;
    }
    code = await executeTsdownBuildPlan(plan);
  }
  if (code === 0) {
    sanitizeTsdownBuildOutputRoots(args.forwardedArgs, options.cwd);
  }
  return code;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  process.exitCode = parseTsdownBuildArgs(argv).help
    ? await runTsdownBuild(argv)
    : await withDistArtifactOwnership(process.cwd(), () => runTsdownBuild(argv));
}
