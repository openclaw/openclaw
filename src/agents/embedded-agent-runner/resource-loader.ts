/**
 * Creates the resource loader used by embedded-agent sessions.
 */
import { DefaultResourceLoader } from "../sessions/index.js";

/**
 * Resource-loader setup for embedded-agent sessions.
 *
 * Embedded runs receive explicit tools/resources from the runner, so discovery disables ambient
 * extensions, skills, prompt templates, themes, and context files.
 */
type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Discovery options that keep embedded sessions isolated from ambient local resources. */
export const EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

/** Creates the constrained resource loader used by embedded-agent session construction. */
export function createEmbeddedAgentResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager" | "extensionFactories"
  >,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  });
}

import fs from "node:fs";
import path from "node:path";

/**
 * Mtime-tracked cache for resource loader reloads.
 * Avoids re-reading settings files from disk on every embedded run
 * when nothing has changed.
 */
type ResourceLoaderCacheEntry = {
  lastMtimeMs: number;
  lastCheckMs: number;
};

const resourceLoaderCache = new Map<string, ResourceLoaderCacheEntry>();
const RESOURCE_LOADER_CACHE_MAX_SIZE = 64;
const RESOURCE_LOADER_CACHE_TTL_MS = 30_000;
const RESOURCE_LOADER_STALE_MS = 2_000;

function getSettingsMtime(cwd: string, agentDir?: string): number {
  let maxMtime = 0;
  const dirs = [cwd];
  if (agentDir) {
    dirs.push(agentDir);
  }
  for (const dir of dirs) {
    try {
      const settingsPath = path.join(dir, ".openclaw", "settings.json");
      const stat = fs.statSync(settingsPath, { throwIfNoEntry: false });
      if (stat) {
        maxMtime = Math.max(maxMtime, stat.mtimeMs);
      }
    } catch {
      // settings file may not exist
    }
  }
  return maxMtime;
}

/**
 * Returns true if the resource loader should skip reload() because
 * settings files haven't changed since the last cache check.
 */
export function shouldSkipResourceLoaderReload(cwd: string, agentDir?: string): boolean {
  const cacheKey = `${cwd}\x00${agentDir ?? ""}`;
  const now = Date.now();
  const entry = resourceLoaderCache.get(cacheKey);
  const currentMtime = getSettingsMtime(cwd, agentDir);

  if (entry) {
    if (
      entry.lastMtimeMs === currentMtime &&
      now - entry.lastCheckMs < RESOURCE_LOADER_CACHE_TTL_MS
    ) {
      return true;
    }
    if (entry.lastMtimeMs !== currentMtime && now - entry.lastCheckMs < RESOURCE_LOADER_STALE_MS) {
      return true;
    }
  }

  resourceLoaderCache.set(cacheKey, {
    lastMtimeMs: currentMtime,
    lastCheckMs: now,
  });
  if (resourceLoaderCache.size > RESOURCE_LOADER_CACHE_MAX_SIZE) {
    const oldest = resourceLoaderCache.keys().next().value;
    if (oldest) {
      resourceLoaderCache.delete(oldest);
    }
  }
  return false;
}

export function clearResourceLoaderCacheForTest(): void {
  resourceLoaderCache.clear();
}
