import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
// Canonical watched-input state shared by artifact producers and freshness readers.
import type fs from "node:fs";
import path from "node:path";
import {
  extensionRestartMetadataFiles,
  isBuildRelevantRunNodePath,
  normalizeRunNodePath as normalizePath,
  runNodeWatchedPaths,
} from "../run-node-watch-paths.mts";
import { collectSourceCheckoutPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listStaticExtensionAssetSources } from "./static-extension-assets.mts";

export type RunNodeInputDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: typeof fs;
  distRoot: string;
  spawnSync: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout?: string | null };
};

export type BundledPluginBuildEntry = ReturnType<
  typeof collectSourceCheckoutPluginBuildEntries
>[number] & {
  hasManifest: boolean;
};
export const runtimePostBuildWatchedPaths = [
  "scripts/check-built-plugin-control-plane-modules.mts",
  "scripts/copy-bundled-plugin-metadata.mjs",
  "scripts/copy-bundled-plugin-metadata.mts",
  "scripts/copy-hook-metadata.ts",
  "scripts/lib",
  "scripts/lib/local-build-metadata.mts",
  "scripts/lib/local-build-metadata-paths.mts",
  "scripts/npm-runner.mts",
  "scripts/runtime-postbuild-stamp.mts",
  "scripts/runtime-postbuild-shared.mjs",
  "scripts/runtime-postbuild.mjs",
  "scripts/runtime-postbuild.mts",
  "scripts/stage-bundled-plugin-runtime.mjs",
  "scripts/stage-bundled-plugin-runtime.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/write-build-info.ts",
  "scripts/write-official-channel-catalog.mjs",
  "scripts/write-official-channel-catalog.mts",
  BUNDLED_PLUGIN_ROOT_DIR,
];
const runtimePostBuildScriptPaths = new Set(
  runtimePostBuildWatchedPaths.filter((entry) => entry.startsWith("scripts/")),
);
const runtimePostBuildStaticAssetPaths = new Set(listStaticExtensionAssetSources());

const readGitStatus = (deps: RunNodeInputDeps, paths: string[] = runNodeWatchedPaths) => {
  try {
    const result = deps.spawnSync(
      "git",
      // NUL framing preserves filenames; separate delete/add records keep both rename sides.
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=normal",
        "--",
        ...paths,
      ],
      {
        cwd: deps.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout ?? "";
  } catch {
    return null;
  }
};

const parseGitStatusPaths = (output: string) =>
  output
    .split("\0")
    .map((entry) => entry.slice(3))
    .filter(Boolean);

export const hasDirtySourceTree = (deps: RunNodeInputDeps) => {
  const output = readGitStatus(deps);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some(
    (repoPath) =>
      isBuildRelevantRunNodePath(repoPath) ||
      isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs(repoPath, deps),
  );
};

export const isRuntimePostBuildRelevantPath = (repoPath: string) => {
  const normalizedPath = normalizePath(repoPath);
  if (runtimePostBuildStaticAssetPaths.has(normalizedPath)) {
    return true;
  }
  if (
    normalizedPath.startsWith("scripts/") &&
    (runtimePostBuildScriptPaths.has(normalizedPath) || normalizedPath.startsWith("scripts/lib/"))
  ) {
    return true;
  }
  if (!normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return false;
  }
  const pluginRelativePath = normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length);
  const pluginLocalPath = pluginRelativePath.split("/").slice(1).join("/");
  if (pluginLocalPath === "skills" || pluginLocalPath.startsWith("skills/")) {
    return true;
  }
  return extensionRestartMetadataFiles.has(path.posix.basename(pluginRelativePath));
};

export const hasDirtyRuntimePostBuildInputs = (deps: RunNodeInputDeps) => {
  const output = readGitStatus(deps, runtimePostBuildWatchedPaths);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some((repoPath) => isRuntimePostBuildRelevantPath(repoPath));
};

export const collectRunNodeBundledPluginBuildEntries = (deps: RunNodeInputDeps) => {
  if (!deps.fs.existsSync(path.join(deps.cwd, BUNDLED_PLUGIN_ROOT_DIR))) {
    return [];
  }
  return collectSourceCheckoutPluginBuildEntries({ cwd: deps.cwd, env: deps.env });
};

const resolveBuiltBundledPluginRuntimeEntryPath = (
  distRoot: string,
  pluginId: string,
  sourceEntry: string,
  runtimeExtension: string,
) =>
  path.join(
    distRoot,
    "extensions",
    pluginId,
    sourceEntry.replace(/^\.\//, "").replace(/\.[^.]+$/u, runtimeExtension),
  );

export const listBundledPluginRuntimeEntryPaths = (
  pluginEntry: BundledPluginBuildEntry,
  deps: RunNodeInputDeps,
) => {
  const distRoot = deps.distRoot;
  return pluginEntry.sourceEntries
    .map((sourceEntry) =>
      resolveBuiltBundledPluginRuntimeEntryPath(
        distRoot,
        pluginEntry.id,
        sourceEntry,
        pluginEntry.runtimeExtension,
      ),
    )
    .toSorted((left, right) => left.localeCompare(right));
};

const isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs = (
  normalizedPath: string,
  deps: RunNodeInputDeps,
) => {
  if (!normalizedPath.startsWith("extensions/") || !normalizedPath.endsWith("/package.json")) {
    return false;
  }
  const [, pluginId] = normalizedPath.split("/");
  if (!pluginId) {
    return false;
  }
  const pluginEntry = collectRunNodeBundledPluginBuildEntries(deps).find(
    (entry) => entry.id === pluginId,
  );
  if (!pluginEntry) {
    return false;
  }
  return listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some(
    (filePath) => !deps.fs.existsSync(filePath),
  );
};
