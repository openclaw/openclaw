/**
 * Eviction Strategy
 *
 * Manages warm store size by evicting old segments.
 * Evicted segments remain in cold storage (JSONL) and can be reloaded on demand.
 */

export interface EvictionConfig {
  /** Max age in days before eviction from warm store (default: 90) */
  maxAgeDays: number;
  /** Whether eviction is enabled */
  enabled: boolean;
}

export const DEFAULT_EVICTION: EvictionConfig = {
  maxAgeDays: 90,
  enabled: true,
};

/**
 * Determine which segment IDs should be evicted based on age.
 *
 * @param segments - Iterable of segments with id and timestamp
 * @param config - Eviction configuration
 * @param now - Current time in ms (default: Date.now())
 * @returns Set of segment IDs to evict
 */
export function getEvictableIds(
  segments: Iterable<{ id: string; timestamp: number }>,
  config: EvictionConfig,
  now = Date.now(),
): Set<string> {
  if (!config.enabled) {
    return new Set();
  }

  const cutoff = now - config.maxAgeDays * 24 * 60 * 60 * 1000;
  const ids = new Set<string>();

  for (const seg of segments) {
    if (seg.timestamp < cutoff) {
      ids.add(seg.id);
    }
  }

  return ids;
}

/**
 * Check if a single segment should be evicted.
 */
export function shouldEvict(timestamp: number, config: EvictionConfig, now = Date.now()): boolean {
  if (!config.enabled) {
    return false;
  }
  const cutoff = now - config.maxAgeDays * 24 * 60 * 60 * 1000;
  return timestamp < cutoff;
}
