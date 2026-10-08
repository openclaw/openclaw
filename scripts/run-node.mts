#!/usr/bin/env node
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { applyCliProfileEnv, parseCliProfileArgs } from "../src/cli/profile.ts";
import {
  getCommandArgsWithRootOptions,
  getRootOptionAwareCommandPath,
} from "../src/infra/cli-root-options.ts";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { resolveLiveManagedGatewayDistFence } from "./lib/live-gateway-dist-fence.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  resolveGitHead,
  writeRuntimePostBuildStamp as writeDistRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mts";
import { resolveQaCodexApiKeyEnvPatch } from "./lib/qa-codex-auth-env.mts";
import {
  captureRunNodeInputState,
  type RunNodeInputState,
  collectRunNodeBundledPluginBuildEntries,
  hasDirtySourceTree,
  resolveRunNodeInputSignature,
  hasDirtyRuntimePostBuildInputs,
  isRuntimePostBuildRelevantPath,
  listBundledPluginRuntimeEntryPaths,
  runtimePostBuildWatchedPaths,
  type BundledPluginBuildEntry,
} from "./lib/run-node-input-state.mts";
import {
  discoverStaticExtensionAssets,
  resolveStaticExtensionAssetSource,
  shouldCopyStaticExtensionAssets,
} from "./lib/static-extension-assets.mts";
import { resolveTestRuntime } from "./lib/test-runtime.mts";
import {
  isBuildRelevantRunNodePath,
  normalizeRunNodePath as normalizePath,
  runNodeConfigFiles,
  runNodeSourceRoots,
  runNodeWatchedPaths,
} from "./run-node-watch-paths.mts";
import { listCoreRuntimePostBuildOutputs, runRuntimePostBuild } from "./runtime-postbuild.mts";
import { listTsdownOutputRoots } from "./tsdown-build.mts";

type RunNodeSpawnSync = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { error?: NodeJS.ErrnoException; status: number | null; stdout?: string | null };
type RunNodeMainParams = {
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  // Publication must join an asynchronous writer before releasing build ownership.
  runRuntimePostBuild?: (
    params?: Parameters<typeof runRuntimePostBuild>[0],
  ) => void | Promise<void>;
};
type RunNodeProgress = {
  clearLine(): void;
  render(): void;
  stop(): void;
};
type RunNodeDeps = ReturnType<typeof createRunNodeDeps>;
type RunNodeRequirementDeps = {
  buildStampPath: string;
  configFiles: string[];
  cwd: string;
  distEntry: string;
  distRoot: string;
  env: NodeJS.ProcessEnv;
  fs: typeof fs;
  privateQaRequiredDistEntries?: string[];
  sourceRoots: Array<{ name: string; path: string }>;
  spawnSync: RunNodeSpawnSync;
};
type RunNodeRuntimeRequirementDeps = RunNodeRequirementDeps & {
  runtimePostBuildStampPath: string;
};
type RunNodeOutputTee = {
  write(chunk: string | Uint8Array): void;
  close(): Promise<void>;
};
type RunNodeMutableState = {
  outputTee: RunNodeOutputTee | null;
  runNodeProgress: RunNodeProgress | undefined;
};
type RunNodeLogDeps = Pick<RunNodeDeps, "env"> &
  Partial<Pick<RunNodeDeps, "outputTee" | "runNodeProgress">> & {
    stderr: Pick<NodeJS.WriteStream, "write">;
  };
type RunNodeLockDeps = Pick<RunNodeDeps, "cwd" | "env" | "fs" | "process"> & {
  args: readonly string[];
  stderr: RunNodeLogDeps["stderr"];
};
type BuildRequirement = { shouldBuild: boolean; reason: keyof typeof BUILD_REASON_LABELS };
type RuntimePostBuildRequirement = {
  shouldSync: boolean;
  reason: keyof typeof RUNTIME_POSTBUILD_REASON_LABELS;
};
type SpawnedProcessResult = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  forwardedSignal: NodeJS.Signals | null;
};
type RunNodeExit = number | NodeJS.Signals;

export { runNodeWatchedPaths };

const RUN_NODE_DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const RUN_NODE_MAX_SHUTDOWN_GRACE_MS = 5 * 60_000;
const RUN_NODE_SHUTDOWN_GRACE_MESSAGE_TYPE = "openclaw:shutdown-grace";

function resolveRunNodeShutdownGraceMessage(message: unknown): number | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== RUN_NODE_SHUTDOWN_GRACE_MESSAGE_TYPE ||
    !("graceMs" in message) ||
    typeof message.graceMs !== "number" ||
    !Number.isSafeInteger(message.graceMs) ||
    message.graceMs <= 0 ||
    message.graceMs > RUN_NODE_MAX_SHUTDOWN_GRACE_MS
  ) {
    return undefined;
  }
  return Math.max(RUN_NODE_DEFAULT_SHUTDOWN_GRACE_MS, message.graceMs);
}

const statMtime = (filePath: string, fsImpl: typeof fs = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const resolvePrivateQaRequiredDistEntries = (distRoot: string) => [
  path.join(distRoot, "plugin-sdk", "qa-lab.js"),
  path.join(distRoot, "plugin-sdk", "qa-runtime.js"),
];
const isExcludedSource = (filePath: string, sourceRoot: string, sourceRootName: string) => {
  const relativePath = normalizePath(path.relative(sourceRoot, filePath));
  // A basename starting with ".." still belongs to the source root.
  if (relativePath === ".." || relativePath.startsWith("../")) {
    return false;
  }
  return !isBuildRelevantRunNodePath(path.posix.join(sourceRootName, relativePath));
};

const findLatestMtime = (
  dirPath: string,
  shouldSkip: ((filePath: string) => boolean) | undefined,
  deps: RunNodeRequirementDeps,
) => {
  let latest: number | null = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath, deps.fs);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const readJsonStamp = (filePath: string, deps: RunNodeRequirementDeps) => {
  const mtime = statMtime(filePath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null, inputsClean: null, inputSignature: null, staticAssets: null };
  }
  try {
    const raw = deps.fs.readFileSync(filePath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null, inputsClean: null, inputSignature: null, staticAssets: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return {
      mtime,
      head,
      inputsClean: typeof parsed?.inputsClean === "boolean" ? parsed.inputsClean : null,
      staticAssets: Object.hasOwn(parsed, "staticAssets") ? parsed.staticAssets === true : null,
      inputSignature: Object.hasOwn(parsed, "inputSignature")
        ? typeof parsed.inputSignature === "string" && /^[a-f0-9]{64}$/u.test(parsed.inputSignature)
          ? parsed.inputSignature
          : ""
        : null,
    };
  } catch {
    return { mtime, head: null, inputsClean: null, inputSignature: null, staticAssets: null };
  }
};

const readBuildStamp = (deps: RunNodeRequirementDeps) => readJsonStamp(deps.buildStampPath, deps);

const readRuntimePostBuildStamp = (deps: RunNodeRuntimeRequirementDeps) => {
  return readJsonStamp(deps.runtimePostBuildStampPath, deps);
};

const isImmutableGitDeployment = (deps: RunNodeRequirementDeps) => {
  try {
    const deployment = JSON.parse(
      deps.fs.readFileSync(path.join(deps.cwd, "deployment.json"), "utf8"),
    );
    // Deployment ownership outranks source-checkout freshness. A mismatched
    // checkout must fail closed instead of repairing manager-owned artifacts.
    return (
      deployment?.kind === "git" &&
      typeof deployment.sourceHead === "string" &&
      deployment.sourceHead.trim().length > 0
    );
  } catch {
    return false;
  }
};

const hasSourceMtimeChanged = (stampMtime: number, deps: RunNodeRequirementDeps) => {
  let latestSourceMtime: number | null = null;
  for (const sourceRoot of deps.sourceRoots) {
    const sourceMtime = findLatestMtime(
      sourceRoot.path,
      (candidate) => isExcludedSource(candidate, sourceRoot.path, sourceRoot.name),
      deps,
    );
    if (sourceMtime != null && (latestSourceMtime == null || sourceMtime > latestSourceMtime)) {
      latestSourceMtime = sourceMtime;
    }
  }
  return latestSourceMtime != null && latestSourceMtime > stampMtime;
};

const findLatestRuntimePostBuildInputMtime = (
  absolutePath: string,
  relativePath: string,
  deps: RunNodeRequirementDeps,
) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const statsMtime = statMtime(absolutePath, deps.fs);
  if (statsMtime == null) {
    return null;
  }
  let stat;
  try {
    stat = deps.fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    return isRuntimePostBuildRelevantPath(normalizedRelativePath) ? statsMtime : null;
  }
  return findLatestMtime(
    absolutePath,
    (candidate) => {
      const candidateRelativePath = path.relative(deps.cwd, candidate);
      return !isRuntimePostBuildRelevantPath(candidateRelativePath);
    },
    deps,
  );
};

const hasRuntimePostBuildInputMtimeChanged = (stampMtime: number, deps: RunNodeRequirementDeps) => {
  let latestInputMtime: number | null = null;
  for (const relativePath of runtimePostBuildWatchedPaths) {
    const absolutePath = path.join(deps.cwd, relativePath);
    const inputMtime = findLatestRuntimePostBuildInputMtime(absolutePath, relativePath, deps);
    if (inputMtime != null && (latestInputMtime == null || inputMtime > latestInputMtime)) {
      latestInputMtime = inputMtime;
    }
  }
  return latestInputMtime != null && latestInputMtime > stampMtime;
};

const hasMissingBuiltBundledPluginRuntimeEntryOutput = (deps: RunNodeRequirementDeps) => {
  return collectRunNodeBundledPluginBuildEntries(deps).some((pluginEntry) => {
    const entryPaths = listBundledPluginRuntimeEntryPaths(pluginEntry, deps);
    return entryPaths.some((filePath) => !deps.fs.existsSync(filePath));
  });
};

const listBuiltBundledPluginEntries = (deps: RunNodeRequirementDeps) => {
  return collectRunNodeBundledPluginBuildEntries(deps)
    .filter((pluginEntry) =>
      listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some((filePath) =>
        deps.fs.existsSync(filePath),
      ),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
};

const listRequiredBundledPluginMetadataOutputs = (
  pluginEntries: BundledPluginBuildEntry[],
  deps: RunNodeRequirementDeps,
) =>
  pluginEntries.flatMap(({ id, hasManifest, hasPackageJson }) => {
    const builtPluginDir = path.join(deps.distRoot, "extensions", id);
    const requiredPaths = [];
    if (hasPackageJson) {
      requiredPaths.push(path.join(builtPluginDir, "package.json"));
    }
    if (hasManifest) {
      requiredPaths.push(path.join(builtPluginDir, "openclaw.plugin.json"));
    }
    return requiredPaths;
  });

const hasMissingBundledPluginRuntimeOverlayOutput = (deps: RunNodeRequirementDeps) => {
  const distExtensionsRoot = path.join(deps.distRoot, "extensions");
  const runtimeExtensionsRoot = path.join(deps.cwd, "dist-runtime", "extensions");
  const queue = [distExtensionsRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (current !== distExtensionsRoot && (entry.isFile() || entry.isSymbolicLink())) {
        const runtimePath = path.join(
          runtimeExtensionsRoot,
          path.relative(distExtensionsRoot, entryPath),
        );
        if (statMtime(runtimePath, deps.fs) == null) {
          return true;
        }
      }
    }
  }
  return false;
};

const isSafePluginSdkSubpathSegment = (subpath: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);

const readPackageJsonPluginSdkAliasFileNames = (deps: RunNodeRequirementDeps) => {
  let packageJson;
  try {
    packageJson = JSON.parse(deps.fs.readFileSync(path.join(deps.cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const packageExports = packageJson?.exports;
  if (!packageExports || typeof packageExports !== "object" || Array.isArray(packageExports)) {
    return null;
  }

  const fileNames = new Set<string>();
  for (const exportKey of Object.keys(packageExports)) {
    if (!exportKey.startsWith("./plugin-sdk/")) {
      continue;
    }
    const subpath = exportKey.slice("./plugin-sdk/".length);
    if (isSafePluginSdkSubpathSegment(subpath)) {
      fileNames.add(`${subpath}.js`);
    }
  }
  return fileNames.size > 0 ? fileNames : null;
};

const listRequiredOpenClawExtensionAliasOutputs = (deps: RunNodeRequirementDeps) => {
  const distRoot = deps.distRoot;
  const distExtensionsRoot = path.join(distRoot, "extensions");
  if (!deps.fs.existsSync(distExtensionsRoot)) {
    return [];
  }
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  let dirents;
  try {
    dirents = deps.fs.readdirSync(pluginSdkDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const exportedPluginSdkFileNames = readPackageJsonPluginSdkAliasFileNames(deps);
  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  return [
    path.join(aliasDir, "package.json"),
    ...dirents
      .filter((dirent) => dirent.isFile() && path.extname(dirent.name) === ".js")
      .filter(
        (dirent) => !exportedPluginSdkFileNames || exportedPluginSdkFileNames.has(dirent.name),
      )
      .map((dirent) => path.join(aliasDir, "plugin-sdk", dirent.name)),
  ].toSorted((left, right) => left.localeCompare(right));
};

const listRequiredStaticExtensionAssetOutputs = (deps: RunNodeRequirementDeps) => {
  if (!shouldCopyStaticExtensionAssets({ env: deps.env })) {
    return [];
  }
  const distRoot = deps.distRoot;
  const runtimeRoot = path.join(deps.cwd, "dist-runtime");
  const runtimeExtensionsRoot = path.join(runtimeRoot, "extensions");
  const hasRuntimeOverlay = deps.fs.existsSync(runtimeExtensionsRoot);
  return discoverStaticExtensionAssets({ rootDir: deps.cwd, fs: deps.fs })
    .filter((asset) =>
      deps.fs.existsSync(resolveStaticExtensionAssetSource(deps.cwd, asset, deps.fs)),
    )
    .flatMap((asset) => {
      const relativeOutput = normalizePath(asset.dest).replace(/^dist\//u, "");
      const outputs = [path.join(distRoot, relativeOutput)];
      if (hasRuntimeOverlay) {
        outputs.push(path.join(runtimeRoot, relativeOutput));
      }
      return outputs;
    })
    .toSorted((left, right) => left.localeCompare(right));
};

const listRequiredCoreRuntimePostBuildOutputs = (deps: RunNodeRequirementDeps) =>
  listCoreRuntimePostBuildOutputs({ rootDir: deps.cwd, fs: deps.fs }).map((relativePath) =>
    path.join(deps.cwd, normalizePath(relativePath)),
  );

const hasMissingRequiredRuntimePostBuildOutput = (deps: RunNodeRequirementDeps) => {
  const builtPluginEntries = listBuiltBundledPluginEntries(deps);
  // Keep discovery failures ahead of missing-output checks.
  const requiredOutputGroups = [
    listRequiredCoreRuntimePostBuildOutputs(deps),
    listRequiredOpenClawExtensionAliasOutputs(deps),
    listRequiredStaticExtensionAssetOutputs(deps),
    listRequiredBundledPluginMetadataOutputs(builtPluginEntries, deps),
  ];
  return (
    requiredOutputGroups.some((outputs) =>
      outputs.some((filePath) => statMtime(filePath, deps.fs) == null),
    ) || hasMissingBundledPluginRuntimeOverlayOutput(deps)
  );
};

export const resolveBuildRequirement = (
  deps: RunNodeRequirementDeps,
  options: { allowEquivalentInputs?: boolean } = {},
): BuildRequirement => {
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return { shouldBuild: true, reason: "force_build" };
  }
  if (
    deps.env.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
    (deps.privateQaRequiredDistEntries ?? resolvePrivateQaRequiredDistEntries(deps.distRoot)).some(
      (entry) => statMtime(entry, deps.fs) == null,
    )
  ) {
    return { shouldBuild: true, reason: "missing_private_qa_dist" };
  }
  const stamp = readBuildStamp(deps);
  if (stamp.mtime == null) {
    return { shouldBuild: true, reason: "missing_build_stamp" };
  }
  if (statMtime(deps.distEntry, deps.fs) == null) {
    return { shouldBuild: true, reason: "missing_dist_entry" };
  }

  const currentHead = resolveGitHead(deps);
  if (
    stamp.inputSignature === "" ||
    (!currentHead && stamp.inputSignature !== null && stamp.inputsClean !== true)
  ) {
    return { shouldBuild: true, reason: "build_inputs_unverified" };
  }
  if (currentHead && !stamp.head) {
    return { shouldBuild: true, reason: "build_stamp_missing_head" };
  }
  const headChanged = Boolean(currentHead && stamp.head && currentHead !== stamp.head);
  const immutable = isImmutableGitDeployment(deps);
  if (headChanged && (!options.allowEquivalentInputs || immutable)) {
    return { shouldBuild: true, reason: "git_head_changed" };
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    // Preserve the portable clean-artifact contract; fingerprints are needed
    // for dirty inputs and test capsules whose private carrier HEAD changed.
    if (
      !headChanged &&
      dirty === false &&
      stamp.inputsClean === true &&
      (!options.allowEquivalentInputs ||
        isImmutableGitDeployment(deps) ||
        stamp.inputSignature === null)
    ) {
      return hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)
        ? { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" }
        : { shouldBuild: false, reason: "clean" };
    }
    if (options.allowEquivalentInputs && stamp.inputSignature !== null && !immutable) {
      if (stamp.inputSignature !== resolveRunNodeInputSignature(deps, "build")) {
        return { shouldBuild: true, reason: "build_inputs_changed" };
      }
      return hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)
        ? { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" }
        : { shouldBuild: false, reason: "clean" };
    }
    if (headChanged) {
      return { shouldBuild: true, reason: "git_head_changed" };
    }
    if (dirty === true) {
      return { shouldBuild: true, reason: "dirty_watched_tree" };
    }
    if (dirty === false) {
      if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
        return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
      }
      if (stamp.inputsClean !== true) {
        return { shouldBuild: true, reason: "build_inputs_unverified" };
      }
      return { shouldBuild: false, reason: "clean" };
    }
  }

  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      return { shouldBuild: true, reason: "config_newer" };
    }
  }

  if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
    return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
  }

  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    return { shouldBuild: true, reason: "source_mtime_newer" };
  }
  return { shouldBuild: false, reason: "clean" };
};

export const resolveRuntimePostBuildRequirement = (
  deps: RunNodeRuntimeRequirementDeps,
  options: { requireCleanInputs?: boolean; allowEquivalentInputs?: boolean } = {},
): RuntimePostBuildRequirement => {
  if (deps.env.OPENCLAW_FORCE_RUNTIME_POSTBUILD === "1") {
    return { shouldSync: true, reason: "force_runtime_postbuild" };
  }

  const stamp = readRuntimePostBuildStamp(deps);
  if (stamp.mtime == null) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_stamp" };
  }

  if (
    shouldCopyStaticExtensionAssets({ env: deps.env }) &&
    (stamp.staticAssets === false || (stamp.inputSignature !== null && stamp.staticAssets !== true))
  ) {
    return { shouldSync: true, reason: "static_assets_not_prepared" };
  }

  const buildStamp = readBuildStamp(deps);
  if (buildStamp.mtime == null) {
    return { shouldSync: true, reason: "missing_build_stamp" };
  }
  if (buildStamp.mtime > stamp.mtime) {
    return { shouldSync: true, reason: "build_stamp_newer" };
  }

  const currentHead = resolveGitHead(deps);
  if (
    stamp.inputSignature === "" ||
    (!currentHead && stamp.inputSignature !== null && stamp.inputsClean !== true)
  ) {
    return { shouldSync: true, reason: "runtime_inputs_unverified" };
  }
  if (currentHead && !stamp.head) {
    return { shouldSync: true, reason: "runtime_postbuild_stamp_missing_head" };
  }
  const headChanged = Boolean(currentHead && stamp.head && currentHead !== stamp.head);
  if (
    headChanged &&
    (!options.allowEquivalentInputs ||
      isImmutableGitDeployment(deps) ||
      buildStamp.head !== stamp.head)
  ) {
    return { shouldSync: true, reason: "git_head_changed" };
  }
  if (currentHead) {
    const dirty = hasDirtyRuntimePostBuildInputs(deps);
    if (
      !headChanged &&
      dirty === false &&
      stamp.inputsClean === true &&
      (!options.allowEquivalentInputs ||
        isImmutableGitDeployment(deps) ||
        stamp.inputSignature === null)
    ) {
      return hasMissingRequiredRuntimePostBuildOutput(deps)
        ? { shouldSync: true, reason: "missing_runtime_postbuild_output" }
        : { shouldSync: false, reason: "clean" };
    }
    if (
      options.allowEquivalentInputs &&
      stamp.inputSignature !== null &&
      !isImmutableGitDeployment(deps)
    ) {
      if (stamp.inputSignature !== resolveRunNodeInputSignature(deps, "runtime")) {
        return { shouldSync: true, reason: "runtime_inputs_changed" };
      }
      return hasMissingRequiredRuntimePostBuildOutput(deps)
        ? { shouldSync: true, reason: "missing_runtime_postbuild_output" }
        : { shouldSync: false, reason: "clean" };
    }
    if (headChanged) {
      return { shouldSync: true, reason: "git_head_changed" };
    }
    if (dirty === true) {
      return { shouldSync: true, reason: "dirty_runtime_postbuild_inputs" };
    }
    if (dirty === false) {
      if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
        return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
      }
      if (options.requireCleanInputs !== false && stamp.inputsClean !== true) {
        return { shouldSync: true, reason: "runtime_inputs_unverified" };
      }
      return { shouldSync: false, reason: "clean" };
    }
  }

  if (hasRuntimePostBuildInputMtimeChanged(stamp.mtime, deps)) {
    return { shouldSync: true, reason: "runtime_postbuild_input_mtime_newer" };
  }

  if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
  }

  return { shouldSync: false, reason: "clean" };
};

const BUILD_REASON_LABELS = {
  force_build: "forced by OPENCLAW_FORCE_BUILD",
  missing_build_stamp: "build stamp missing",
  missing_dist_entry: "dist entry missing",
  config_newer: "config newer than build stamp",
  build_stamp_missing_head: "build stamp missing git head",
  build_inputs_changed: "build input bytes or toolchain changed",
  build_inputs_unverified: "build inputs were not verified clean",
  git_head_changed: "git head changed",
  dirty_watched_tree: "dirty watched source tree",
  missing_bundled_plugin_dist_entry: "bundled plugin dist entry missing",
  source_mtime_newer: "source mtime newer than build stamp",
  missing_private_qa_dist: "private QA dist entry missing",
  clean: "clean",
};

const RUNTIME_POSTBUILD_REASON_LABELS = {
  force_runtime_postbuild: "forced by OPENCLAW_FORCE_RUNTIME_POSTBUILD",
  missing_runtime_postbuild_output: "required runtime postbuild output missing",
  missing_runtime_postbuild_stamp: "runtime postbuild stamp missing",
  missing_build_stamp: "build stamp missing",
  build_stamp_newer: "build stamp newer than runtime postbuild stamp",
  runtime_postbuild_stamp_missing_head: "runtime postbuild stamp missing git head",
  static_assets_not_prepared: "runtime static assets were not verified",
  runtime_inputs_changed: "runtime input bytes or toolchain changed",
  runtime_inputs_unverified: "runtime postbuild inputs were not verified clean",
  git_head_changed: "git head changed",
  dirty_runtime_postbuild_inputs: "dirty runtime postbuild inputs",
  runtime_postbuild_input_mtime_newer: "runtime postbuild input mtime newer than stamp",
  clean: "clean",
};

const formatBuildReason = (reason: BuildRequirement["reason"]) => BUILD_REASON_LABELS[reason];
const formatRuntimePostBuildReason = (reason: RuntimePostBuildRequirement["reason"]) =>
  RUNTIME_POSTBUILD_REASON_LABELS[reason];

const refuseImmutableDeploymentMutation = (
  deps: RunNodeDeps,
  artifactKind: "build" | "runtime",
  reason: string,
) => {
  const message =
    `[openclaw] Cannot regenerate ${artifactKind} artifacts in an immutable deployment (${reason}). ` +
    "Replace this deployment with a complete release, then use its installed `openclaw` command or run `node openclaw.mjs ...` from that release.\n";
  deps.stderr.write(message);
  deps.outputTee?.write(message);
  return 1;
};

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const isSignalKey = (signal: NodeJS.Signals): signal is keyof typeof SIGNAL_EXIT_CODES =>
  Object.hasOwn(SIGNAL_EXIT_CODES, signal);

const getSignalExitCode = (signal: NodeJS.Signals) =>
  isSignalKey(signal) ? SIGNAL_EXIT_CODES[signal] : 1;

const RUN_NODE_OUTPUT_LOG_ENV = "OPENCLAW_RUN_NODE_OUTPUT_LOG";
const RUN_NODE_CPU_PROF_DIR_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_DIR";
const RUN_NODE_CPU_PROF_MAX_FILES_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES";
const RUN_NODE_FILTER_SYNC_IO_STDERR_ENV = "OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR";
const RUN_NODE_BUILD_LOCK_TIMEOUT_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_TIMEOUT_MS";
const RUN_NODE_BUILD_LOCK_POLL_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS";
const RUN_NODE_BUILD_LOCK_STALE_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_STALE_MS";
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";
const DEFAULT_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUILD_LOCK_POLL_MS = 100;
const DEFAULT_BUILD_LOCK_STALE_MS = 10 * 60 * 1000;

const hasErrorCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "unknown error";

const parsePositiveIntegerEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) =>
  parsePositiveInteger(env[name]) ?? fallback;

const resolveRunNodeOutputLogPath = (deps: RunNodeDeps) => {
  const outputLog = deps.env[RUN_NODE_OUTPUT_LOG_ENV]?.trim();
  if (!outputLog) {
    return null;
  }
  return path.resolve(deps.cwd, outputLog);
};

const createRunNodeOutputTee = (deps: RunNodeDeps): RunNodeOutputTee | null => {
  const outputLogPath = resolveRunNodeOutputLogPath(deps);
  if (!outputLogPath) {
    return null;
  }
  try {
    const existing = deps.fs.statSync(outputLogPath);
    if (existing.isDirectory()) {
      return {
        write() {},
        async close() {
          throw new Error(`output log path is a directory: ${outputLogPath}`);
        },
      };
    }
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode && errorCode !== "ENOENT") {
      return {
        write() {},
        async close() {
          throw error;
        },
      };
    }
  }
  deps.fs.mkdirSync(path.dirname(outputLogPath), { recursive: true });
  const stream = deps.fs.createWriteStream(outputLogPath, {
    flags: "a",
    mode: 0o600,
  });
  let streamError: Error | null = null;
  const getStreamError = () => streamError;
  stream.on("error", (error: Error) => {
    streamError = error;
  });
  deps.env[RUN_NODE_OUTPUT_LOG_ENV] = outputLogPath;
  return {
    write(chunk: string | Uint8Array) {
      if (!streamError) {
        stream.write(chunk);
      }
    },
    async close() {
      const closeError = getStreamError();
      if (closeError) {
        throw closeError;
      }
      await new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
      const endError = getStreamError();
      if (endError) {
        throw endError;
      }
    },
  };
};

const logRunner = (message: string, deps: RunNodeLogDeps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  const line = `[openclaw] ${message}\n`;
  deps.runNodeProgress?.clearLine();
  deps.stderr.write(line);
  deps.runNodeProgress?.render();
  deps.outputTee?.write(line);
};

const RUN_NODE_PROGRESS_FRAMES = ["-", "\\", "|", "/"];

const shouldUseRunNodeProgress = (deps: RunNodeDeps) =>
  deps.stderr.isTTY &&
  deps.env.OPENCLAW_RUNNER_PROGRESS !== "0" &&
  deps.env.CI !== "true" &&
  !deps.outputTee;

const createRunNodeProgress = (label: string, deps: RunNodeDeps) => {
  if (!shouldUseRunNodeProgress(deps)) {
    return null;
  }
  const startedAt = Date.now();
  let frameIndex = 0;
  let active = true;
  let visible = false;

  const clearLine = () => {
    if (!visible) {
      return;
    }
    deps.stderr.write("\r\x1b[2K");
    visible = false;
  };
  const render = () => {
    if (!active) {
      return;
    }
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const frame = RUN_NODE_PROGRESS_FRAMES[frameIndex % RUN_NODE_PROGRESS_FRAMES.length];
    frameIndex += 1;
    deps.stderr.write(`\r[openclaw] ${frame} ${label} (${elapsedSeconds}s)`);
    visible = true;
  };
  const timer = setInterval(render, 120);
  timer.unref?.();
  render();

  return {
    clearLine,
    render,
    stop() {
      if (!active) {
        return;
      }
      active = false;
      clearInterval(timer);
      clearLine();
    },
  };
};

const withRunNodeProgress = async <T,>(
  deps: RunNodeDeps,
  label: string,
  callback: () => Promise<T>,
) => {
  const previousProgress = deps.runNodeProgress;
  const progress = createRunNodeProgress(label, deps);
  if (progress) {
    deps.runNodeProgress = progress;
  }
  try {
    return await callback();
  } finally {
    if (progress) {
      progress.stop();
      deps.runNodeProgress = previousProgress;
    }
  }
};

const writeRunnerStream = (
  deps: RunNodeDeps,
  stream: NodeJS.WriteStream,
  chunk: string | Uint8Array,
) => {
  deps.runNodeProgress?.clearLine();
  stream.write(chunk);
  deps.runNodeProgress?.render();
};

const shouldPipeSpawnedOutput = (deps: RunNodeDeps) =>
  Boolean(deps.outputTee || deps.runNodeProgress);

const sanitizeCpuProfileNamePart = (value: string | undefined) => {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "command";
};

const parsePositiveInteger = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const listRunNodeCpuProfiles = (
  deps: RunNodeDeps,
  absoluteProfileDir: string,
  commandName: string,
) => {
  let entries;
  try {
    entries = deps.fs.readdirSync(absoluteProfileDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `openclaw-${commandName}-`;
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".cpuprofile"),
    )
    .flatMap((entry) => {
      const filePath = path.join(absoluteProfileDir, entry.name);
      try {
        const stat = deps.fs.statSync(filePath);
        return [{ filePath, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    })
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
};

const pruneRunNodeCpuProfiles = (
  deps: RunNodeDeps,
  absoluteProfileDir: string,
  commandName: string,
) => {
  const maxFiles = parsePositiveInteger(deps.env[RUN_NODE_CPU_PROF_MAX_FILES_ENV]);
  if (!maxFiles) {
    return;
  }
  const profiles = listRunNodeCpuProfiles(deps, absoluteProfileDir, commandName);
  const deleteCount = Math.max(0, profiles.length - maxFiles + 1);
  for (const profile of profiles.slice(0, deleteCount)) {
    try {
      deps.fs.rmSync(profile.filePath, { force: true });
    } catch {
      // Best-effort artifact rotation; profiling should not fail the command.
    }
  }
};

const resolveRunNodeCpuProfileArgs = (deps: RunNodeDeps) => {
  const profileDir = deps.env[RUN_NODE_CPU_PROF_DIR_ENV]?.trim();
  if (!profileDir) {
    return [];
  }

  const absoluteProfileDir = path.resolve(deps.cwd, profileDir);
  deps.fs.mkdirSync(absoluteProfileDir, { recursive: true });
  deps.env[RUN_NODE_CPU_PROF_DIR_ENV] = absoluteProfileDir;

  const commandName = sanitizeCpuProfileNamePart(deps.args[0]);
  pruneRunNodeCpuProfiles(deps, absoluteProfileDir, commandName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pid = Number.isInteger(deps.process.pid) && deps.process.pid > 0 ? deps.process.pid : "pid";
  const profileName = `openclaw-${commandName}-${pid}-${timestamp}.cpuprofile`;
  const profilePath = path.join(absoluteProfileDir, profileName);
  const relativeProfilePath = path.relative(deps.cwd, profilePath) || profilePath;
  logRunner(`Writing Node CPU profile to ${relativeProfilePath}.`, deps);
  return ["--cpu-prof", `--cpu-prof-dir=${absoluteProfileDir}`, `--cpu-prof-name=${profileName}`];
};

const resolveRunNodeDiagnosticArgs = (deps: RunNodeDeps) => {
  const args = [...resolveRunNodeCpuProfileArgs(deps)];
  if (deps.env.OPENCLAW_TRACE_SYNC_IO === "1") {
    logRunner("Enabling Node --trace-sync-io for startup I/O diagnostics.", deps);
    args.push("--trace-sync-io");
  }
  return args;
};

const shouldUseRunNodeChildProcessGroup = (deps: RunNodeDeps) =>
  deps.platform !== "win32" && !deps.process.stdin?.isTTY;

const signalSpawnedProcess = (
  childProcess: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
  deps: RunNodeDeps,
) => {
  if (useProcessGroup && typeof childProcess.pid === "number") {
    try {
      deps.process.kill(-childProcess.pid, signal);
      return;
    } catch (error) {
      if (hasErrorCode(error, "ESRCH") || hasErrorCode(error, "EPERM")) {
        return;
      }
    }
  }
  try {
    childProcess.kill?.(signal);
  } catch {
    // Best-effort only. Exit handling still happens via the child "exit" event.
  }
};

const waitForSpawnedProcess = async (
  childProcess: ChildProcess,
  deps: RunNodeDeps,
  acceptShutdownGrace = false,
) => {
  let forwardedSignal: NodeJS.Signals | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let cleanedForwardedSignalGroup = false;
  let shutdownGraceMs = RUN_NODE_DEFAULT_SHUTDOWN_GRACE_MS;
  const useProcessGroup = shouldUseRunNodeChildProcessGroup(deps);

  const onMessage = (message: unknown) => {
    // The child declares lifecycle needs before interruption; freezing this at
    // the first signal prevents late messages from extending shutdown forever.
    if (forwardedSignal) {
      return;
    }
    const requestedGraceMs = resolveRunNodeShutdownGraceMessage(message);
    if (requestedGraceMs !== undefined) {
      shutdownGraceMs = requestedGraceMs;
    }
  };

  const cleanupSignals = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    for (const [signal, handler] of signalHandlers) {
      deps.process.off(signal, handler);
    }
    childProcess.off?.("message", onMessage);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (forwardedSignal) {
      return;
    }
    forwardedSignal = signal;
    signalSpawnedProcess(childProcess, signal, useProcessGroup, deps);
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      cleanedForwardedSignalGroup = true;
      signalSpawnedProcess(childProcess, "SIGKILL", useProcessGroup, deps);
    }, shutdownGraceMs);
  };

  if (acceptShutdownGrace) {
    childProcess.on("message", onMessage);
  }
  const signalHandlers = FORWARDED_SIGNALS.map(
    (signal) => [signal, () => forwardSignal(signal)] as const,
  );
  for (const [signal, handler] of signalHandlers) {
    deps.process.on(signal, handler);
  }

  try {
    return await new Promise<SpawnedProcessResult>((resolve) => {
      const handleError = (error: Error) => {
        logRunner(`Spawn failed: ${error.message}`, deps);
        resolve({ exitCode: 1, exitSignal: null, forwardedSignal });
      };
      const handleExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        if ((forwardedSignal || exitSignal) && !cleanedForwardedSignalGroup) {
          cleanedForwardedSignalGroup = true;
          signalSpawnedProcess(childProcess, "SIGKILL", useProcessGroup, deps);
        }
        resolve({ exitCode, exitSignal, forwardedSignal });
      };
      childProcess.on("error", handleError);
      childProcess.on("exit", handleExit);
    });
  } finally {
    cleanupSignals();
  }
};

const getInterruptedSpawnOutcome = (
  res: SpawnedProcessResult,
  platform: NodeJS.Platform,
): RunNodeExit | null => {
  if (res.exitSignal) {
    // The child did not acknowledge completion. A numeric exit could let the
    // watch parent retry after the owner of detached workers has disappeared.
    return platform === "win32" ? getSignalExitCode(res.exitSignal) : res.exitSignal;
  }
  if (res.forwardedSignal) {
    return getSignalExitCode(res.forwardedSignal);
  }
  return null;
};

const runNodeChild = async (deps: RunNodeDeps, args: string[], execPath = deps.execPath) => {
  deps.cancellation.signal.throwIfAborted();
  const useProcessGroup = shouldUseRunNodeChildProcessGroup(deps);
  // The parent route grants lifecycle IPC; generic children must not extend
  // the launcher's five-second force-kill boundary with a shaped message.
  const acceptShutdownGrace =
    getCommandArgsWithRootOptions([deps.execPath, "openclaw.mjs", ...deps.args], {
      commandPath: ["qa", "mantis", "run"],
      mode: "command-path",
    }) !== null;
  const nodeProcess = deps.spawn(execPath, args, {
    cwd: deps.cwd,
    detached: useProcessGroup,
    env: deps.env,
    stdio: deps.outputTee
      ? acceptShutdownGrace
        ? ["inherit", "pipe", "pipe", "ipc"]
        : ["inherit", "pipe", "pipe"]
      : acceptShutdownGrace
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
  });
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps, acceptShutdownGrace);
  const interrupted = getInterruptedSpawnOutcome(res, deps.platform);
  if (interrupted !== null) {
    return interrupted;
  }
  return res.exitCode ?? 1;
};

const runOpenClaw = (deps: RunNodeDeps) =>
  runNodeChild(
    deps,
    [...resolveRunNodeDiagnosticArgs(deps), "openclaw.mjs", ...deps.args],
    resolveTestRuntime(deps.env) === "bun" ? "bun" : deps.execPath,
  );

const pipeSpawnedOutput = (
  childProcess: ChildProcess,
  deps: RunNodeDeps,
  options: { stdoutTarget?: "stdout" | "stderr" } = {},
) => {
  const stdoutTarget = options.stdoutTarget ?? "stdout";
  if (!shouldPipeSpawnedOutput(deps) && stdoutTarget !== "stderr") {
    return;
  }
  const stderrFilter =
    deps.env[RUN_NODE_FILTER_SYNC_IO_STDERR_ENV] === "1"
      ? createSyncIoTraceStderrFilter(deps)
      : null;
  const stdout: Pick<NodeJS.ReadableStream, "on"> | null | undefined = childProcess.stdout;
  const stderr: Pick<NodeJS.ReadableStream, "on"> | null | undefined = childProcess.stderr;
  stdout?.on("data", (chunk: string | Uint8Array) => {
    const target = stdoutTarget === "stderr" ? deps.stderr : deps.stdout;
    writeRunnerStream(deps, target, chunk);
    deps.outputTee?.write(chunk);
  });
  stderr?.on("data", (chunk: string | Uint8Array) => {
    deps.runNodeProgress?.clearLine();
    if (stderrFilter) {
      stderrFilter.write(chunk);
    } else {
      deps.stderr.write(chunk);
    }
    deps.runNodeProgress?.render();
    deps.outputTee?.write(chunk);
  });
  stderr?.on("end", () => {
    stderrFilter?.flush();
  });
};

const createSyncIoTraceStderrFilter = (deps: RunNodeDeps) => {
  let buffer = "";
  let inSyncIoTrace = false;

  const shouldSuppressLine = (line: string) => {
    const text = line.replace(/\r?\n$/, "");
    if (/^\(node:\d+\) WARNING: Detected use of sync API/.test(text)) {
      inSyncIoTrace = true;
      return true;
    }
    if (!inSyncIoTrace) {
      return false;
    }
    if (text.trim() === "") {
      inSyncIoTrace = false;
      return true;
    }
    if (/^\s+at\b/.test(text)) {
      return true;
    }
    inSyncIoTrace = false;
    return false;
  };

  const writeLine = (line: string) => {
    if (!shouldSuppressLine(line)) {
      deps.stderr.write(line);
    }
  };

  return {
    write(chunk: string | Uint8Array) {
      buffer += String(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        writeLine(line);
      }
    },
    flush() {
      if (!buffer) {
        return;
      }
      writeLine(buffer);
      buffer = "";
    },
  };
};

const closeRunNodeOutputTee = async (deps: RunNodeDeps, exitCode: RunNodeExit) => {
  if (!deps.outputTee) {
    return exitCode;
  }
  try {
    await deps.outputTee.close();
  } catch (error) {
    deps.stderr.write(`[openclaw] Failed to write output log: ${getErrorMessage(error)}\n`);
    return exitCode === 0 ? 1 : exitCode;
  }
  return exitCode;
};

const readBuildLockOwnerPid = (deps: RunNodeLockDeps, lockDir: string) => {
  try {
    const raw = deps.fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isBuildLockOwnerDead = (deps: RunNodeLockDeps, pid: number) => {
  try {
    deps.process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasErrorCode(error, "ESRCH");
  }
};

const removeStaleBuildLock = (deps: RunNodeLockDeps, lockDir: string, staleMs: number) => {
  try {
    const ownerPid = readBuildLockOwnerPid(deps, lockDir);
    if (ownerPid !== null && isBuildLockOwnerDead(deps, ownerPid)) {
      deps.fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    const stats = deps.fs.statSync(lockDir);
    if (Date.now() - stats.mtimeMs < staleMs) {
      return false;
    }
    deps.fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const acquireRunNodeBuildLock = async (
  deps: RunNodeLockDeps,
  signal?: AbortSignal,
): Promise<() => void> => {
  const lockRoot = path.join(deps.cwd, ".artifacts");
  const lockDir = path.join(lockRoot, "run-node-build.lock");
  const timeoutMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_TIMEOUT_ENV,
    DEFAULT_BUILD_LOCK_TIMEOUT_MS,
  );
  const pollMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_POLL_ENV,
    DEFAULT_BUILD_LOCK_POLL_MS,
  );
  const staleMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_STALE_ENV,
    DEFAULT_BUILD_LOCK_STALE_MS,
  );
  const startedAt = Date.now();
  let waitLogBudget = 1;
  const consumeWaitLog = () => waitLogBudget-- > 0;

  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    try {
      deps.fs.mkdirSync(lockRoot, { recursive: true });
      deps.fs.mkdirSync(lockDir);
      try {
        deps.fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify(
            {
              pid: deps.process.pid,
              startedAt: new Date().toISOString(),
              args: deps.args,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch {
        // Owner metadata is diagnostic only; the directory itself is the lock.
      }
      let released = false;
      const removeLockDir = () => {
        if (released) {
          return;
        }
        released = true;
        try {
          deps.fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; a follow-up waiter will fall back to staleness
          // detection if the directory is still present.
        }
      };
      deps.process.on("exit", removeLockDir);
      return () => {
        deps.process.off("exit", removeLockDir);
        removeLockDir();
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (removeStaleBuildLock(deps, lockDir, staleMs)) {
        continue;
      }
      if (consumeWaitLog()) {
        logRunner("Waiting for TypeScript/runtime artifact lock.", deps);
      }
      // Cancellation must wake a contended wait, not only the next poll.
      await delay(pollMs, undefined, signal ? { signal } : undefined);
    }
  }

  throw new Error(`timed out waiting for ${path.relative(deps.cwd, lockDir)}`);
};

const withRunNodeBuildLock = async <T,>(deps: RunNodeDeps, callback: () => Promise<T>) => {
  const release = await acquireRunNodeBuildLock(deps, deps.cancellation.signal);
  try {
    deps.cancellation.signal.throwIfAborted();
    return await callback();
  } finally {
    release();
  }
};

const withRunNodeRuntimePublication = async <T,>(deps: RunNodeDeps, publish: () => Promise<T>) => {
  deps.cancellation.signal.throwIfAborted();
  const { withGatewayRuntimeArtifactPublication } =
    await import("../src/cli/update-cli/update-command-service-publication.ts");
  deps.cancellation.signal.throwIfAborted();
  const selected = parseCliProfileArgs([deps.execPath, "openclaw.mjs", ...deps.args]);
  if (!selected.ok) {
    throw new Error(selected.error);
  }
  const env = { ...deps.env };
  if (selected.profile) {
    applyCliProfileEnv({ profile: selected.profile, env });
  }
  return await withGatewayRuntimeArtifactPublication(
    {
      root: deps.cwd,
      env,
      timeoutMs: 60_000,
      outputPaths: listTsdownOutputRoots(),
      assertCurrent() {},
    },
    async () => {
      deps.cancellation.signal.throwIfAborted();
      return await publish();
    },
  );
};

const syncRuntimeArtifacts = async (deps: RunNodeDeps) => {
  try {
    await deps.runRuntimePostBuild({ cwd: deps.cwd, env: deps.env });
  } catch (error) {
    logRunner(`Failed to write runtime build artifacts: ${getErrorMessage(error)}`, deps);
    return false;
  }
  return true;
};

const writeRuntimePostBuildStamp = (deps: RunNodeDeps, inputState: RunNodeInputState | null) => {
  try {
    writeDistRuntimePostBuildStamp({
      cwd: deps.cwd,
      fs: deps.fs,
      env: deps.env,
      spawnSync: deps.spawnSync,
      inputState,
    });
    return true;
  } catch (error) {
    logRunner(`Failed to write runtime postbuild stamp: ${getErrorMessage(error)}`, deps);
    return false;
  }
};

const refuseLiveDistMutation = async (deps: RunNodeDeps) => {
  const fence = await resolveLiveManagedGatewayDistFence(deps.cwd, { env: deps.env });
  if (!fence.refuse) {
    return false;
  }
  const message = `${fence.message}\n`;
  deps.stderr.write(message);
  deps.outputTee?.write(message);
  return true;
};

const syncRuntimeArtifactsAndStamp = async (deps: RunNodeDeps) =>
  withDistArtifactOwnership(
    deps.cwd,
    async () => {
      deps.cancellation.signal.throwIfAborted();
      if (!resolveRuntimePostBuildRequirement(deps).shouldSync) {
        return true;
      }
      return await withRunNodeRuntimePublication(deps, async () => {
        if (await refuseLiveDistMutation(deps)) {
          return false;
        }
        deps.cancellation.signal.throwIfAborted();
        const inputState = captureRunNodeInputState(deps, "runtime");
        deps.fs.rmSync(deps.runtimePostBuildStampPath, { force: true });
        const synced = await syncRuntimeArtifacts(deps);
        deps.cancellation.signal.throwIfAborted();
        if (synced) {
          return writeRuntimePostBuildStamp(deps, inputState);
        }
        return false;
      });
    },
    deps.cancellation.signal,
  );

const shouldSkipWatchRuntimeSync = (deps: RunNodeDeps, requirement: RuntimePostBuildRequirement) =>
  deps.env.OPENCLAW_WATCH_MODE === "1" &&
  requirement.reason === "missing_runtime_postbuild_stamp" &&
  hasDirtyRuntimePostBuildInputs(deps) !== true &&
  !hasMissingRequiredRuntimePostBuildOutput(deps);

const resolveRunNodeCommandPath = (args: string[], depth: number) =>
  getRootOptionAwareCommandPath(["node", "openclaw", ...args], depth);

const isGatewayClientCommand = (args: string[]) => {
  const [primary, secondary] = resolveRunNodeCommandPath(args, 2);
  return (
    primary === "dashboard" ||
    (primary === "gateway" && (secondary === "call" || secondary === "status")) ||
    (primary === "agent" && !args.includes("--local"))
  );
};

const isGatewayRecoveryCommand = (args: string[]) => {
  const [primary, secondary] = resolveRunNodeCommandPath(args, 2);
  return primary === "gateway" && (secondary === "stop" || secondary === "restart");
};

const shouldFastPathExistingDistForGatewayRecovery = (deps: RunNodeDeps) =>
  isGatewayRecoveryCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(deps.distEntry, deps.fs) != null;

const shouldFastPathExistingDistForGatewayClient = (deps: RunNodeDeps) =>
  isGatewayClientCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(deps.distEntry, deps.fs) != null &&
  canUseStampedGatewayClientDist(deps);

const shouldFastPathExistingDist = (deps: RunNodeDeps) =>
  shouldFastPathExistingDistForGatewayRecovery(deps) ||
  shouldFastPathExistingDistForGatewayClient(deps);

const applyRunNodeCliProfile = (args: string[], env: NodeJS.ProcessEnv, execPath: string) => {
  const parsed = parseCliProfileArgs([execPath, "openclaw", ...args]);
  if (parsed.ok && parsed.profile) {
    applyCliProfileEnv({ profile: parsed.profile, env });
  }
};

const canUseStampedGatewayClientDist = (deps: RunNodeDeps) => {
  const currentHead = resolveGitHead(deps);
  if (!currentHead) {
    return false;
  }
  const buildStamp = readBuildStamp(deps);
  if (buildStamp.mtime == null || buildStamp.head !== currentHead) {
    return false;
  }
  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > buildStamp.mtime) {
      return false;
    }
  }
  if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
    return false;
  }
  const runtimeStamp = readRuntimePostBuildStamp(deps);
  if (
    runtimeStamp.mtime == null ||
    runtimeStamp.mtime < buildStamp.mtime ||
    runtimeStamp.head !== currentHead ||
    deps.env.OPENCLAW_FORCE_RUNTIME_POSTBUILD === "1"
  ) {
    return false;
  }
  // Remote clients intentionally use existing dist. Retain metadata/output checks
  // without treating producer source cleanliness as a client rebuild requirement.
  return !resolveRuntimePostBuildRequirement(deps, { requireCleanInputs: false }).shouldSync;
};

type QaReportScript = "qa-parity-report.ts" | "qa-coverage-report.ts";

const resolveQaReportSourceScript = (deps: RunNodeDeps, buildRequirement: BuildRequirement) => {
  const sourceEntrypoint = path.join(deps.cwd, "extensions", "qa-lab", "src", "cli.runtime.ts");
  if (
    buildRequirement.reason !== "missing_private_qa_dist" ||
    deps.args[0] !== "qa" ||
    deps.env.OPENCLAW_FORCE_BUILD === "1" ||
    statMtime(sourceEntrypoint, deps.fs) == null
  ) {
    return null;
  }
  return deps.args[1] === "parity-report"
    ? "qa-parity-report.ts"
    : deps.args[1] === "coverage"
      ? "qa-coverage-report.ts"
      : null;
};

const runQaReportFromSource = (deps: RunNodeDeps, script: QaReportScript) => {
  const sourceEntrypoint = path.join(deps.cwd, "scripts", script);
  return runNodeChild(deps, ["--import", "tsx", sourceEntrypoint, ...deps.args.slice(2)]);
};

function createRunNodeDeps(params: RunNodeMainParams) {
  const postbuild: NonNullable<RunNodeMainParams["runRuntimePostBuild"]> =
    params.runRuntimePostBuild ?? runRuntimePostBuild;
  const cwd = params.cwd ?? process.cwd();
  const distRoot = path.join(cwd, "dist");
  const args = params.args ?? process.argv.slice(2);
  const execPath = process.execPath;
  const env = params.env ? { ...params.env } : { ...process.env };
  // Select this checkout's plugins over tracked installs without changing source/dist loading.
  env.OPENCLAW_DEV_SOURCE_ROOT ??= cwd;
  applyRunNodeCliProfile(args, env, execPath);
  const mutableState: RunNodeMutableState = {
    outputTee: null,
    runNodeProgress: undefined,
  };
  return {
    spawn,
    spawnSync,
    fs,
    stderr: process.stderr,
    stdout: process.stdout,
    process,
    execPath,
    cwd,
    args,
    env,
    platform: process.platform,
    runRuntimePostBuild: postbuild,
    cancellation: new AbortController(),
    distRoot,
    distEntry: path.join(distRoot, "/entry.js"),
    buildStampPath: path.join(distRoot, BUILD_STAMP_FILE),
    runtimePostBuildStampPath: path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE),
    sourceRoots: runNodeSourceRoots.map((name) => ({ name, path: path.join(cwd, name) })),
    configFiles: runNodeConfigFiles.map((filePath) => path.join(cwd, filePath)),
    privateQaRequiredDistEntries: resolvePrivateQaRequiredDistEntries(distRoot),
    ...mutableState,
  };
}

/** Read-only build admission shared by explicit test preparation and the source runner. */
export function resolveRunNodePreparation(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { allowEquivalentInputs?: boolean } = {},
) {
  const deps = createRunNodeDeps({ cwd, env, args: [] });
  let build = resolveBuildRequirement(deps, options).shouldBuild;
  let runtime = !build && resolveRuntimePostBuildRequirement(deps, options).shouldSync;
  // A partial refresh must not relabel an older compiled generation while CLI
  // and UI metadata still retain its identity. Reuse only a coherent generation.
  if (
    !build &&
    runtime &&
    options.allowEquivalentInputs &&
    resolveGitHead(deps) !== readBuildStamp(deps).head
  ) {
    build = true;
    runtime = false;
  }
  return { build, runtime, immutable: (build || runtime) && isImmutableGitDeployment(deps) };
}

export async function runNodeMain(params: RunNodeMainParams = {}): Promise<RunNodeExit> {
  const deps = createRunNodeDeps(params);
  if (deps.args[0] === "qa") {
    deps.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
    deps.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    deps.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ??= "0";
    Object.assign(
      deps.env,
      resolveQaCodexApiKeyEnvPatch({
        args: deps.args,
        env: deps.env,
      }),
    );
  }
  deps.outputTee = createRunNodeOutputTee(deps);
  // Children own signal forwarding; retain cancellation across in-process steps
  // and join active work before releasing its locks.
  let interruptedSignal: NodeJS.Signals | undefined;
  const signalHandlers = FORWARDED_SIGNALS.map(
    (signal) =>
      [
        signal,
        () => {
          interruptedSignal ??= signal;
          deps.cancellation.abort(new Error(`Source runner interrupted by ${signal}`));
        },
      ] as const,
  );
  for (const [signal, handler] of signalHandlers) {
    deps.process.on(signal, handler);
  }
  const finishRun = async (exitCode: RunNodeExit): Promise<RunNodeExit> => {
    const outcome = await closeRunNodeOutputTee(deps, exitCode);
    return interruptedSignal && typeof outcome !== "string"
      ? getSignalExitCode(interruptedSignal)
      : outcome;
  };

  try {
    let exitCode: RunNodeExit = 1;
    if (shouldFastPathExistingDist(deps)) {
      exitCode = await runOpenClaw(deps);
      return await finishRun(exitCode);
    }
    const buildRequirement = resolveBuildRequirement(deps);
    const immutableDeployment = isImmutableGitDeployment(deps);
    if (immutableDeployment && buildRequirement.shouldBuild) {
      return await finishRun(
        refuseImmutableDeploymentMutation(
          deps,
          "build",
          formatBuildReason(buildRequirement.reason),
        ),
      );
    }
    const qaReportScript = resolveQaReportSourceScript(deps, buildRequirement);
    if (qaReportScript) {
      const reportName = qaReportScript === "qa-parity-report.ts" ? "parity" : "coverage";
      logRunner(
        `Running QA ${reportName} report from source without rebuilding private QA dist.`,
        deps,
      );
      exitCode = await runQaReportFromSource(deps, qaReportScript);
      return await finishRun(exitCode);
    }
    if (!buildRequirement.shouldBuild) {
      const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
      if (immutableDeployment && runtimePostBuildRequirement.shouldSync) {
        return await finishRun(
          refuseImmutableDeploymentMutation(
            deps,
            "runtime",
            formatRuntimePostBuildReason(runtimePostBuildRequirement.reason),
          ),
        );
      }
      if (
        runtimePostBuildRequirement.shouldSync &&
        !shouldSkipWatchRuntimeSync(deps, runtimePostBuildRequirement)
      ) {
        const synced = await withRunNodeBuildLock(deps, async () => {
          const lockedRuntimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
          if (!lockedRuntimePostBuildRequirement.shouldSync) {
            return true;
          }
          logRunner(
            `Syncing runtime artifacts (${lockedRuntimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(lockedRuntimePostBuildRequirement.reason)}).`,
            deps,
          );
          return await syncRuntimeArtifactsAndStamp(deps);
        });
        if (!synced) {
          return await finishRun(1);
        }
      }
      exitCode = await runOpenClaw(deps);
      return await finishRun(exitCode);
    }

    const buildExitCode = await withRunNodeBuildLock(deps, async () => {
      if (shouldFastPathExistingDist(deps)) {
        return 0;
      }
      const lockedBuildRequirement = resolveBuildRequirement(deps);
      if (!lockedBuildRequirement.shouldBuild) {
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        if (!runtimePostBuildRequirement.shouldSync) {
          return 0;
        }
        logRunner(
          `Syncing runtime artifacts (${runtimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(runtimePostBuildRequirement.reason)}).`,
          deps,
        );
        return (await syncRuntimeArtifactsAndStamp(deps)) ? 0 : 1;
      }

      return await withDistArtifactOwnership(
        deps.cwd,
        () =>
          withRunNodeRuntimePublication(deps, async () => {
            if (await refuseLiveDistMutation(deps)) {
              return 1;
            }
            logRunner(
              `Building TypeScript (dist is stale: ${lockedBuildRequirement.reason} - ${formatBuildReason(lockedBuildRequirement.reason)}).`,
              deps,
            );
            return await withRunNodeProgress(deps, "Building local CLI artifacts", async () => {
              deps.cancellation.signal.throwIfAborted();
              const build = deps.spawn(
                deps.execPath,
                distArtifactEntryArgs(path.join(deps.cwd, "scripts/build-all.mts"), ["qaRuntime"]),
                {
                  cwd: deps.cwd,
                  detached: shouldUseRunNodeChildProcessGroup(deps),
                  env: {
                    ...deps.env,
                    [RUN_NODE_SKIP_DTS_BUILD_ENV]: deps.env[RUN_NODE_SKIP_DTS_BUILD_ENV] ?? "1",
                  },
                  stdio: ["inherit", "pipe", "pipe"],
                },
              );
              pipeSpawnedOutput(build, deps, { stdoutTarget: "stderr" });
              const result = await waitForSpawnedProcess(build, deps);
              return getInterruptedSpawnOutcome(result, deps.platform) ?? result.exitCode ?? 1;
            });
          }),
        deps.cancellation.signal,
      );
    });
    if (buildExitCode !== 0) {
      return await finishRun(buildExitCode);
    }
    exitCode = await runOpenClaw(deps);
    return await finishRun(exitCode);
  } catch (error) {
    const outcome = await finishRun(1);
    if (interruptedSignal) {
      return outcome;
    }
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      deps.process.off(signal, handler);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((outcome) => {
      if (typeof outcome === "string") {
        process.kill(process.pid, outcome);
        return;
      }
      process.exit(outcome);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
