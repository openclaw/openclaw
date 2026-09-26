import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { acquireDistArtifactOwnership } from "./dist-artifact-lock.mts";
import { isRecord } from "./record-shared.mjs";
import type { PrepareBundledPluginRuntime } from "./runtime-artifact-contract.js";

const hasPreparation = (
  value: unknown,
): value is { prepareBundledPluginRuntime: PrepareBundledPluginRuntime } =>
  isRecord(value) && typeof value.prepareBundledPluginRuntime === "function";

export async function loadSourceRuntimePreparation(root: string) {
  const stagingFile = path.join(root, "scripts", "stage-bundled-plugin-runtime.mts");
  try {
    fs.lstatSync(stagingFile);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const staging: unknown = await import(pathToFileURL(stagingFile).href);
  if (hasPreparation(staging)) {
    return staging.prepareBundledPluginRuntime;
  }
  if (
    isRecord(staging) &&
    staging.prepareBundledPluginRuntime === undefined &&
    typeof staging.stageBundledPluginRuntime === "function"
  ) {
    return undefined;
  }
  throw new Error(`Installed runtime staging is unavailable: ${stagingFile}`);
}

export async function inspectSourceUpdateArtifacts(rootDir: string): Promise<{
  sourceRuntimePrepared: boolean;
  lock: FileLockHandle | undefined;
}> {
  if (!fs.existsSync(path.join(rootDir, ".git"))) {
    return { sourceRuntimePrepared: true, lock: undefined };
  }
  const root = fs.realpathSync(rootDir);
  const lock = await acquireDistArtifactOwnership(root);
  try {
    const prepare = await loadSourceRuntimePreparation(root);
    const prepared = prepare?.({ repoRoot: root });
    await prepared?.cleanup();
    return { sourceRuntimePrepared: !prepared?.changed, lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Published drivers already expose the installed checkout through this cache path. */
export async function preflightInstalledSourceArtifacts(env: NodeJS.ProcessEnv) {
  const cacheRoot = env.BUILD_ALL_CACHE_ROOT?.trim();
  if (
    env.sourceRuntimePrepared === "true" ||
    env.sourceRuntimePrepared === "false" ||
    env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" ||
    !cacheRoot ||
    !path.isAbsolute(cacheRoot) ||
    path.basename(cacheRoot) !== "build-all-cache" ||
    path.basename(path.dirname(cacheRoot)) !== ".artifacts"
  ) {
    return;
  }
  const root = path.dirname(path.dirname(cacheRoot));
  if (!fs.existsSync(path.join(root, ".git"))) {
    return;
  }
  if (fs.realpathSync(root) !== fs.realpathSync(process.cwd())) {
    await (await inspectSourceUpdateArtifacts(root)).lock?.release();
  }
}
