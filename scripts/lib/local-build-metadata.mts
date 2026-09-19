// Writes local build metadata stamps into dist output after build phases.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE } from "./local-build-metadata-paths.mts";
import { hasDirtyRuntimePostBuildInputs, hasDirtySourceTree } from "./run-node-input-state.mts";

export { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE };

type BuildMetadataSpawnSync = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout?: string | null };

type BuildMetadataParams = {
  cwd?: string;
  fs?: typeof fs;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  spawnSync?: BuildMetadataSpawnSync;
};

function resolveInputsClean(params: BuildMetadataParams, scope: "build" | "runtime") {
  // HEAD alone cannot identify outputs built before uncommitted edits were reverted.
  const cwd = params.cwd ?? process.cwd();
  const deps = {
    cwd,
    distRoot: path.join(cwd, "dist"),
    fs: params.fs ?? fs,
    env: params.env ?? process.env,
    spawnSync: params.spawnSync ?? spawnSync,
  };
  const dirty = scope === "build" ? hasDirtySourceTree(deps) : hasDirtyRuntimePostBuildInputs(deps);
  return dirty === null ? null : !dirty;
}

/** Resolve the current git HEAD for build stamp metadata. */
export function resolveGitHead(params: BuildMetadataParams = {}) {
  const cwd = params.cwd ?? process.cwd();
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  try {
    const result = spawnSyncImpl("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

/** Write the local build stamp containing timestamp and git head. */
export function writeBuildStamp(params: BuildMetadataParams = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(
    buildStampPath,
    `${JSON.stringify({ builtAt: now(), head, inputsClean: resolveInputsClean(params, "build") })}\n`,
    "utf8",
  );
  return buildStampPath;
}

/** Write the runtime postbuild stamp containing sync timestamp and git head. */
export function writeRuntimePostBuildStamp(params: BuildMetadataParams = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const stampPath = path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        syncedAt: now(),
        ...(head ? { head } : {}),
        inputsClean: resolveInputsClean(params, "runtime"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return stampPath;
}

/** Restored outputs retain their producer identity; only checkout-relative mtimes change. */
export function refreshLocalBuildStampTimes(
  params: Pick<BuildMetadataParams, "cwd" | "fs" | "now"> = {},
) {
  const fsImpl = params.fs ?? fs;
  const time = new Date((params.now ?? Date.now)());
  for (const name of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    try {
      fsImpl.utimesSync(path.join(params.cwd ?? process.cwd(), "dist", name), time, time);
    } catch (error) {
      // Missing stamps remain missing so the ordinary freshness owner can reject them.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
