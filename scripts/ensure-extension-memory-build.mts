#!/usr/bin/env node

// Ensures memory extension runtime entries are built before checks.
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginRootPublicSurfaceLocation } from "../src/plugins/public-surface-runtime.js";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "../src/shared/non-packaged-plugin-dirs.js";
import { runCliStartupBuild, type StartupBuildParams } from "./ensure-cli-startup-build.mts";
import { collectBundledPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

type ExtensionMemoryBuildParams = Omit<StartupBuildParams, "existsSync"> & {
  requiredExtensionIds?: string[];
};

function resolveExtensionMemoryBuildTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return readPositiveEnvInt(
    "OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS",
    env,
    DEFAULT_BUILD_TIMEOUT_MS,
  );
}

function collectExpectedExtensionMemoryEntryIds(rootDir: string, env: NodeJS.ProcessEnv) {
  try {
    const entries = collectBundledPluginBuildEntries({ cwd: rootDir, env });
    return entries
      .filter(
        (entry) =>
          entry.hasManifest &&
          !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(entry.id) &&
          entry.sourceEntries.length > 0,
      )
      .map((entry) => entry.id)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

/** Discovers built index entries for readiness checks and RSS profiling. */
export function findBuiltExtensionMemoryEntries(rootDir: string = repoRoot) {
  const entries = new Map<string, string>();
  // Prefer canonical root output over package-local builds; source-only entries
  // returned by the public-surface resolver must never enter a built-RSS run.
  for (const extensionsDir of [
    path.join(rootDir, "dist", "extensions"),
    path.join(rootDir, "extensions"),
  ]) {
    let extensionIds: string[];
    try {
      extensionIds = readdirSync(extensionsDir);
    } catch {
      continue;
    }
    for (const dir of extensionIds) {
      if (entries.has(dir)) {
        continue;
      }
      const location = resolvePluginRootPublicSurfaceLocation({
        pluginRoot: path.join(extensionsDir, dir),
        artifactBasename: "index.js",
      });
      if (location && /\.[cm]?js$/u.test(location.modulePath)) {
        entries.set(dir, location.modulePath);
      }
    }
  }
  return [...entries]
    .map(([dir, file]) => ({ dir, file }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));
}

export function hasBuiltExtensionMemoryEntries(params: ExtensionMemoryBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const builtIds = new Set(findBuiltExtensionMemoryEntries(rootDir).map((entry) => entry.dir));
  const requiredExtensionIds =
    (params.requiredExtensionIds?.length ?? 0) > 0
      ? params.requiredExtensionIds
      : collectExpectedExtensionMemoryEntryIds(rootDir, params.env ?? process.env);
  if (!requiredExtensionIds || requiredExtensionIds.length === 0) {
    return builtIds.size > 0;
  }
  return requiredExtensionIds.every((id) => builtIds.has(id));
}

export function ensureExtensionMemoryBuild(params: ExtensionMemoryBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  if (hasBuiltExtensionMemoryEntries(params)) {
    return { built: false };
  }

  console.error(
    "[extension-memory-build] required built plugin entries missing; running cliStartup build profile",
  );
  return runCliStartupBuild({
    ...params,
    rootDir,
    timeoutMs: params.timeoutMs ?? resolveExtensionMemoryBuildTimeoutMs(params.env ?? process.env),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureExtensionMemoryBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
