import { createHash } from "node:crypto";
import path from "node:path";
import { resolveVitestFsModuleCacheRoot } from "../../test/vitest/vitest.performance-config.ts";
import type { VitestCacheAssignment } from "../test-projects.test-support.mts";
import { findRepoRoot } from "./repo-root.mjs";

type CacheSpec = {
  config: string;
  env: NodeJS.ProcessEnv;
  watchMode: boolean;
  cacheAssignment?: VitestCacheAssignment;
};

function configCacheKey(config: string, cwd = process.cwd()) {
  const relativeConfig = path
    .relative(findRepoRoot(cwd) ?? cwd, path.resolve(cwd, config))
    .split(path.sep)
    .join("/");
  return createHash("sha256").update(relativeConfig).digest("hex");
}

export function resolveVitestCacheRoot(env: NodeJS.ProcessEnv, cwd = process.cwd()) {
  return (
    env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT?.trim() ||
    resolveVitestFsModuleCacheRoot(findRepoRoot(cwd) ?? cwd)
  );
}

/** Config identity precedes the writer slot so admission order cannot strand a seed. */
export function resolveVitestCacheSlotPath(
  root: string,
  config: string,
  slot = 0,
  cwd = process.cwd(),
) {
  return path.join(root, "slots", configCacheKey(config, cwd), String(slot));
}

/** A slot remains borrowed through preflight and the process owner's final join. */
export function createVitestCacheSlots(platform = process.platform) {
  const idleSlots = new Map<string, number[]>();
  const nextSlots = new Map<string, number>();
  return async <T extends CacheSpec, R extends { groupJoined: boolean }>(
    spec: T,
    run: (assigned: T) => Promise<R>,
  ): Promise<R> => {
    if (platform === "win32" || spec.watchMode || spec.cacheAssignment?.kind !== "scheduler") {
      return run(spec);
    }
    const configKey = configCacheKey(spec.config);
    const cacheKey = path.join(path.resolve(spec.cacheAssignment.root), configKey);
    const available = idleSlots.get(cacheKey) ?? [];
    idleSlots.set(cacheKey, available);
    // Counters span roots: different root spellings may alias one directory.
    // Distinct configs have disjoint directories and each starts at its warm slot.
    let slot = available.pop();
    if (slot === undefined) {
      slot = nextSlots.get(configKey) ?? 0;
      nextSlots.set(configKey, slot + 1);
    }
    const result = await run({
      ...spec,
      cacheAssignment: { ...spec.cacheAssignment, leased: true },
      env: {
        ...spec.env,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          spec.cacheAssignment.root,
          "slots",
          configKey,
          String(slot),
        ),
      },
    });
    // A rejection or child-only completion leaves this slot retired.
    if (result.groupJoined) {
      available.push(slot);
    }
    return result;
  };
}
