/**
 * Friday Optimizations - Token and cost optimization modules.
 *
 * These modules provide:
 * - Working Memory: Rolling context injection for reduced history size
 * - Cost Guard: Budget enforcement and spending limits
 * - Cache Metrics: Tracking cache injection events
 */

export * from "./working-memory.js";
export * from "./cost-guard.js";

// Cache metrics tracking
let cacheInjectionsTotal = 0;
let cacheInjectionsSession = 0;
let lastCacheInjection: string | null = null;

/**
 * Record a cache injection event.
 */
export function recordCacheInjection(model: string): void {
  cacheInjectionsTotal += 1;
  cacheInjectionsSession += 1;
  lastCacheInjection = new Date().toISOString();
}

/**
 * Get cache injection metrics.
 */
export function getCacheMetrics(): {
  total: number;
  session: number;
  lastInjection: string | null;
} {
  return {
    total: cacheInjectionsTotal,
    session: cacheInjectionsSession,
    lastInjection: lastCacheInjection,
  };
}

/**
 * Reset session cache metrics.
 */
export function resetCacheMetrics(): void {
  cacheInjectionsSession = 0;
}

/**
 * Get a combined optimization status for logging.
 */
export function getOptimizationStatus(): string {
  const cache = getCacheMetrics();
  return `[optimizations] Cache injections: ${cache.session} (session), ${cache.total} (total)`;
}
