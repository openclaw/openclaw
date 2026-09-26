import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireDistArtifactOwnership } from "./dist-artifact-ownership.mts";
import { isRecord } from "./record-shared.mjs";
import type { PrepareBundledPluginRuntime } from "./runtime-artifact-contract.js";

function hasRuntimePreparation(
  value: unknown,
): value is { prepareBundledPluginRuntime: PrepareBundledPluginRuntime } {
  return isRecord(value) && typeof value.prepareBundledPluginRuntime === "function";
}

/** Published source updaters expose their installed checkout through this cache
 * location. Probe before candidate writes; an old parent cannot retain our lease. */
export async function preflightInstalledSourceArtifacts(env: NodeJS.ProcessEnv) {
  const cacheRoot = env.BUILD_ALL_CACHE_ROOT?.trim();
  if (
    env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" ||
    !cacheRoot ||
    !path.isAbsolute(cacheRoot) ||
    path.basename(cacheRoot) !== "build-all-cache" ||
    path.basename(path.dirname(cacheRoot)) !== ".artifacts"
  ) {
    return;
  }
  const installedRoot = path.dirname(path.dirname(cacheRoot));
  if (!fs.existsSync(path.join(installedRoot, ".git"))) {
    return;
  }
  const root = fs.realpathSync(installedRoot);
  if (root === fs.realpathSync(process.cwd())) {
    return;
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!isRecord(manifest) || manifest.name !== "openclaw") {
    return;
  }
  const ownership = await acquireDistArtifactOwnership(root);
  try {
    const stagingFile = path.join(root, "scripts", "stage-bundled-plugin-runtime.mts");
    // Stable 2026.4.27 predates this module; 2026.9.4 exposes only the destructive
    // legacy stager. Neither has a prepare-only completion contract to exercise.
    if (!fs.existsSync(stagingFile)) {
      return;
    }
    const staging: unknown = await import(pathToFileURL(stagingFile).href);
    await ownership.assertOwned();
    if (
      isRecord(staging) &&
      staging.prepareBundledPluginRuntime === undefined &&
      typeof staging.stageBundledPluginRuntime === "function"
    ) {
      return;
    }
    if (!hasRuntimePreparation(staging)) {
      throw new Error(
        `The installed source checkout cannot prepare its runtime artifacts: ${root}`,
      );
    }
    const prepared = staging.prepareBundledPluginRuntime({ repoRoot: root });
    await prepared.cleanup();
  } finally {
    await ownership.release();
  }
}
