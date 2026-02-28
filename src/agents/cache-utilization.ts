import type { NormalizedUsage } from "./usage.js";

/**
 * Metrics for cache utilization tracking.
 */
export type CacheUtilizationMetrics = {
  /** Tokens served from cache (cache read) */
  cacheHitTokens: number;
  /** Tokens that had to be processed (input + cache write) */
  cacheMissTokens: number;
  /** Total prompt tokens (input + cacheRead + cacheWrite) */
  totalPromptTokens: number;
  /** Cache hit ratio (0-1) */
  cacheHitRatio: number;
};

/**
 * Compute cache utilization metrics from normalized usage.
 *
 * Cache hit ratio = cacheRead / (input + cacheRead + cacheWrite)
 *
 * This helps understand how effectively prompt caching is being utilized.
 * A higher cache hit ratio means more tokens are being served from cache,
 * reducing both latency and cost.
 */
export function computeCacheUtilization(
  usage: Partial<NormalizedUsage> | null | undefined,
): CacheUtilizationMetrics {
  const input = usage?.input ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;

  const cacheHitTokens = cacheRead;
  const cacheMissTokens = input + cacheWrite;
  const totalPromptTokens = input + cacheRead + cacheWrite;

  const cacheHitRatio = totalPromptTokens > 0 ? cacheHitTokens / totalPromptTokens : 0;

  return {
    cacheHitTokens,
    cacheMissTokens,
    totalPromptTokens,
    cacheHitRatio,
  };
}

/**
 * Format cache utilization metrics as a human-readable summary string.
 *
 * Example: "cache: 66.7% hit (2000/3000 tokens)"
 *
 * Returns empty string if there are no prompt tokens.
 */
export function formatCacheUtilizationSummary(metrics: CacheUtilizationMetrics): string {
  if (metrics.totalPromptTokens === 0) {
    return "";
  }

  const percentage = (metrics.cacheHitRatio * 100).toFixed(1);
  return `cache: ${percentage}% hit (${metrics.cacheHitTokens}/${metrics.totalPromptTokens} tokens)`;
}
