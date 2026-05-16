import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

/**
 * Cached resource loader entry.
 * We cache the loader instance to avoid recreating it on every embedded run,
 * which eliminates the 5-9 second packageManager.resolve() overhead for repeated runs
 * in the same session.
 */
interface CachedResourceLoader {
  loader: DefaultResourceLoader;
  cwd: string;
  agentDir: string;
  createdAt: number;
  lastReloadAt: number;
}

/**
 * Cache TTL in milliseconds.
 * After this period, the cached loader is considered stale and will be recreated.
 * This balances performance (avoiding reload overhead) with correctness (picking up
 * settings changes).
 *
 * Default: 60 seconds. This matches typical session activity patterns where
 * multiple runs happen in quick succession.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Minimum TTL to prevent cache thrashing.
 */
const MIN_CACHE_TTL_MS = 10_000;

/**
 * Maximum TTL to ensure settings changes are eventually picked up.
 */
const MAX_CACHE_TTL_MS = 300_000;

/**
 * Resolve cache TTL from environment or defaults.
 * Allows tuning via OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS for testing or specific workloads.
 */
function resolveCacheTtlMs(): number {
  const envValue = process.env.OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(parsed, MIN_CACHE_TTL_MS), MAX_CACHE_TTL_MS);
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * In-memory cache for resource loaders.
 * Key is computed from cwd + agentDir to distinguish different workspaces.
 */
const resourceLoaderCache = new Map<string, CachedResourceLoader>();

/**
 * Compute cache key from workspace and agent directory.
 */
function computeCacheKey(cwd: string, agentDir: string): string {
  return `${cwd}::${agentDir}`;
}

/**
 * Check if a cached entry is still valid based on TTL.
 */
function isCacheEntryValid(entry: CachedResourceLoader, now: number): boolean {
  const ttlMs = resolveCacheTtlMs();
  return (now - entry.createdAt) < ttlMs;
}

/**
 * Invalidate the resource loader cache.
 * Call this when settings change or when you want to force a fresh reload.
 *
 * @param cwd - If provided, only invalidate entries for this workspace
 * @param agentDir - If provided, only invalidate entries for this agent directory
 */
export function invalidateResourceLoaderCache(cwd?: string, agentDir?: string): void {
  if (cwd && agentDir) {
    resourceLoaderCache.delete(computeCacheKey(cwd, agentDir));
  } else {
    resourceLoaderCache.clear();
  }
}

/**
 * Get the current cache size for diagnostics.
 */
export function getResourceLoaderCacheSize(): number {
  return resourceLoaderCache.size;
}

/**
 * Create or retrieve a cached resource loader.
 *
 * This function caches DefaultResourceLoader instances to avoid the expensive
 * packageManager.resolve() operation (which scans skills directories and blocks
 * the event loop for 5-9 seconds) on every embedded run.
 *
 * @param options - Resource loader init options (cwd, agentDir, settingsManager, extensionFactories)
 */
export function createEmbeddedPiResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager" | "extensionFactories"
  >,
): DefaultResourceLoader {
  const cacheKey = computeCacheKey(options.cwd, options.agentDir);
  const now = Date.now();

  const cached = resourceLoaderCache.get(cacheKey);
  if (cached && isCacheEntryValid(cached, now)) {
    // Cache hit: return existing loader (already reload()ed)
    return cached.loader;
  }

  // Cache miss or expired: create new loader
  const loader = new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  });

  // Store in cache (reload() will be called by caller, then markReloaded())
  resourceLoaderCache.set(cacheKey, {
    loader,
    cwd: options.cwd,
    agentDir: options.agentDir,
    createdAt: now,
    lastReloadAt: 0, // Will be updated after reload()
  });

  return loader;
}

/**
 * Mark that a resource loader has been reload()ed.
 * Call this after successfully calling loader.reload() to update the cache metadata.
 *
 * @param cwd - Workspace directory
 * @param agentDir - Agent directory
 */
export function markResourceLoaderReloaded(cwd: string, agentDir: string): void {
  const cacheKey = computeCacheKey(cwd, agentDir);
  const cached = resourceLoaderCache.get(cacheKey);
  if (cached) {
    cached.lastReloadAt = Date.now();
  }
}

/**
 * Prune expired entries from the cache.
 * Called periodically to prevent unbounded growth.
 */
export function pruneResourceLoaderCache(): void {
  const now = Date.now();
  for (const [key, entry] of resourceLoaderCache.entries()) {
    if (!isCacheEntryValid(entry, now)) {
      resourceLoaderCache.delete(key);
    }
  }
}
