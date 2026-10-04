import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
// Canonical watched-input state shared by artifact producers and freshness readers.
import { createHash } from "node:crypto";
import type fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  extensionRestartMetadataFiles,
  isBuildRelevantRunNodePath,
  isIgnoredRunNodeSourcePath,
  normalizeRunNodePath as normalizePath,
  runNodeWatchedPaths,
} from "../run-node-watch-paths.mts";
import {
  BUNDLED_PLUGIN_BUILD_ENV_NAMES,
  collectSourceCheckoutPluginBuildEntries,
} from "./bundled-plugin-build-entries.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { isRecord } from "./record-shared.mjs";
import {
  listGeneratedExtensionAssetSources,
  listStaticExtensionAssetSources,
} from "./static-extension-assets.mts";
import { TSDOWN_PACKAGES_CACHE_INPUT } from "./tsdown-output-roots.mts";

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

const readGitStatus = (
  deps: RunNodeInputDeps,
  paths: string[] = runNodeWatchedPaths,
  untracked: "normal" | "all" = "normal",
) => {
  try {
    const result = deps.spawnSync(
      "git",
      // NUL framing preserves filenames; separate delete/add records keep both rename sides.
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        `--untracked-files=${untracked}`,
        "--",
        ...paths,
      ],
      {
        cwd: deps.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
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

export const listBundledPluginRuntimeEntryPaths = (
  pluginEntry: BundledPluginBuildEntry,
  deps: RunNodeInputDeps,
) => {
  return pluginEntry.sourceEntries
    .map((sourceEntry) =>
      path.join(
        deps.distRoot,
        "extensions",
        pluginEntry.id,
        sourceEntry.replace(/^\.\//, "").replace(/\.[^.]+$/u, pluginEntry.runtimeExtension),
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

const buildToolPaths = [
  "scripts",
  TSDOWN_PACKAGES_CACHE_INPUT.path,
  "package.json",
  "config",
  ":(glob)packages/**/package.json",
  ":(glob)extensions/*/package.json",
  ":(glob)extensions/*/openclaw.plugin.json",
  ":(glob)packages/**/tsconfig*.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "node-version.mjs",
  ".npmrc",
  "patches",
  ":(glob)tsconfig*.json",
  ":(glob)tsdown*.ts",
];
const isBuildToolPath = (file: string) =>
  file.startsWith("scripts/") ||
  file.startsWith("config/") ||
  file.startsWith("patches/") ||
  /^packages\/.+\/(?:package|tsconfig[^/]*)\.json$/u.test(file) ||
  /^extensions\/[^/]+\/(?:package|openclaw\.plugin)\.json$/u.test(file) ||
  buildToolPaths.includes(file) ||
  /^(?:tsconfig.*\.json|tsdown.*\.ts)$/u.test(file);

function isRunNodeInputPath(
  file: string,
  scope: "build" | "runtime",
  generatedAssets: ReadonlySet<string>,
) {
  const packageSource =
    scope === "build" &&
    file.startsWith(`${TSDOWN_PACKAGES_CACHE_INPUT.path}/`) &&
    !file
      .split("/")
      .some((part) => TSDOWN_PACKAGES_CACHE_INPUT.excludeDirectories.includes(part)) &&
    TSDOWN_PACKAGES_CACHE_INPUT.extensions.some((extension) => file.endsWith(extension)) &&
    !isIgnoredRunNodeSourcePath(file);
  return (
    packageSource ||
    (scope === "build" &&
      file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !isIgnoredRunNodeSourcePath(file) &&
      ![...generatedAssets].some((output) => file === output || file.startsWith(`${output}/`))) ||
    isBuildToolPath(file) ||
    (scope === "build" ? isBuildRelevantRunNodePath(file) : isRuntimePostBuildRelevantPath(file))
  );
}

function listRunNodeInputFiles(deps: RunNodeInputDeps, scope: "build" | "runtime") {
  const watched = scope === "build" ? runNodeWatchedPaths : runtimePostBuildWatchedPaths;
  const result = deps.spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...watched,
      ...buildToolPaths,
    ],
    {
      cwd: deps.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    return null;
  }
  const generatedAssets = new Set(
    listGeneratedExtensionAssetSources({ rootDir: deps.cwd, fs: deps.fs }),
  );
  return [...new Set((result.stdout ?? "").split("\0"))]
    .filter((file) => file && isRunNodeInputPath(file, scope, generatedAssets))
    .toSorted();
}

// A Control UI manifest contains both authored metadata and generated entry paths.
function generatedControlUiManifest(deps: RunNodeInputDeps, file: string) {
  if (!/^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(file)) {
    return false;
  }
  const packagePath = path.join(deps.cwd, path.dirname(file), "package.json");
  if (!deps.fs.existsSync(packagePath)) {
    return false;
  }
  const pkg: unknown = JSON.parse(deps.fs.readFileSync(packagePath, "utf8"));
  const openclaw = isRecord(pkg) && isRecord(pkg.openclaw) ? pkg.openclaw : {};
  const assets = isRecord(openclaw.assetScripts) ? openclaw.assetScripts : {};
  return (
    typeof openclaw.controlUi === "string" &&
    openclaw.controlUi.trim().length > 0 &&
    Array.isArray(assets.buildOutputs) &&
    assets.buildOutputs.includes("openclaw.plugin.json")
  );
}

/** Identifies effective production inputs, independently of transport-carrier commits. */
export function resolveRunNodeInputSignature(
  deps: RunNodeInputDeps,
  scope: "build" | "runtime",
): string | null {
  try {
    const files = listRunNodeInputFiles(deps, scope);
    if (!files) {
      return null;
    }
    const hash = createHash("sha256");
    hash.update(
      JSON.stringify([
        2,
        scope,
        process.version,
        process.platform,
        process.arch,
        BUNDLED_PLUGIN_BUILD_ENV_NAMES.map((key) => [key, deps.env[key] ?? ""]),
      ]),
    );
    const capture = (file: string, optional = false, identity = file) => {
      hash.update(`\0${identity}\0`);
      const absolute = path.resolve(deps.cwd, file);
      try {
        const before = deps.fs.statSync(absolute);
        const link = deps.fs.lstatSync(absolute);
        let contents = deps.fs.readFileSync(absolute);
        if (generatedControlUiManifest(deps, file)) {
          const manifest: unknown = JSON.parse(contents.toString());
          if (!isRecord(manifest)) {
            throw new Error(`Invalid plugin manifest: ${file}`);
          }
          const { controlUi: _generated, ...source } = manifest;
          contents = Buffer.from(JSON.stringify(source));
        }
        hash.update(
          JSON.stringify([
            link.mode,
            contents.length,
            link.isSymbolicLink() ? deps.fs.readlinkSync(absolute) : null,
          ]),
        );
        hash.update(contents);
        const after = deps.fs.statSync(absolute);
        if (
          before.ctimeMs !== after.ctimeMs ||
          before.size !== after.size ||
          before.ino !== after.ino
        ) {
          throw new Error(`Build input changed while reading: ${file}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !optional) {
          throw error;
        }
        hash.update("missing");
      }
    };
    for (const file of files) {
      capture(file, true);
    }
    // Keep the declared compiler installation in the identity without loading it.
    capture("node_modules/.modules.yaml", true);
    const require = createRequire(import.meta.url);
    for (const name of ["tsdown", "typescript"]) {
      capture(require.resolve(`${name}/package.json`), false, `${name}/package.json`);
      capture(require.resolve(name), false, `${name}/entry`);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export type RunNodeInputState = { signature: string; generation: string };

/** Transient mutation evidence includes clean inputs that can change and revert during a build. */
export function captureRunNodeInputState(
  deps: RunNodeInputDeps,
  scope: "build" | "runtime",
  options: { assetPhase?: boolean } = {},
): RunNodeInputState | null {
  const signature = resolveRunNodeInputSignature(deps, scope);
  if (!signature) {
    return null;
  }
  try {
    const files = listRunNodeInputFiles(deps, scope);
    if (!files) {
      return null;
    }
    const generation = createHash("sha256");
    for (const file of files) {
      generation.update(`${file}\0`);
      // The asset writer atomically replaces these files. Their authored fields
      // remain guarded by the signature; later compiler phases also guard stat identity.
      if (options.assetPhase && generatedControlUiManifest(deps, file)) {
        continue;
      }
      try {
        const absolute = path.resolve(deps.cwd, file);
        const link = deps.fs.lstatSync(absolute, { bigint: true });
        const stat = deps.fs.statSync(absolute, { bigint: true });
        generation.update(
          [link.dev, link.ino, link.ctimeNs, stat.dev, stat.ino, stat.ctimeNs, stat.size].join(":"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        generation.update("missing");
      }
      generation.update("\0");
    }
    return { signature, generation: generation.digest("hex") };
  } catch {
    return null;
  }
}
