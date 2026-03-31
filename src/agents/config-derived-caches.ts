// Config-derived cache invalidation registry
//
// Caches that hold state derived from openclaw.json (model catalog, context
// windows, models.json fingerprints, …) must be invalidated when the
// underlying config changes. This module provides a lightweight registry so
// the hot-reload handler can clear them in one call instead of enumerating
// each cache individually.
//
// Process-lifetime caches (code-module imports, ONNX models) and
// request-scoped caches (loadConfig 200ms TTL) are NOT registered here —
// they have different invalidation semantics.

type ConfigDerivedCacheEntry = {
  /** Human-readable name for logging / debugging. */
  name: string;
  /**
   * Config path prefixes this cache depends on.
   * An empty array means "invalidate on any config change".
   */
  prefixes: string[];
  /** Clear the cached state so the next access rebuilds it from config. */
  invalidate: () => void;
};

const registry: ConfigDerivedCacheEntry[] = [];

/**
 * Register a cache that is derived from config and must be invalidated
 * when the corresponding config paths change during hot reload.
 */
export function registerConfigDerivedCache(entry: ConfigDerivedCacheEntry): void {
  registry.push(entry);
}

/**
 * Invalidate all registered caches whose declared prefixes overlap with the
 * changed config paths.  Called by the gateway hot-reload handler.
 *
 * Returns the names of the caches that were actually invalidated (useful for
 * logging).
 */
export function invalidateConfigDerivedCaches(changedPaths: string[]): string[] {
  const invalidated: string[] = [];
  for (const entry of registry) {
    const shouldInvalidate =
      entry.prefixes.length === 0 ||
      entry.prefixes.some((prefix) =>
        changedPaths.some((cp) => cp === prefix || cp.startsWith(prefix + ".")),
      );
    if (shouldInvalidate) {
      entry.invalidate();
      invalidated.push(entry.name);
    }
  }
  return invalidated;
}

/** Test-only: remove all registered caches so tests start with a clean slate. */
export function resetConfigDerivedCacheRegistryForTest(): void {
  registry.length = 0;
}
