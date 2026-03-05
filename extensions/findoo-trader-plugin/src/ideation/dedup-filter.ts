/**
 * DeduplicationFilter — prevents creating duplicate or near-duplicate strategies.
 *
 * Rules:
 * 1. Exact match: same templateId + symbol → reject
 * 2. Parameter similarity: normalized Euclidean distance < 0.15 → reject
 * 3. Rate limit: max N strategies per ideation cycle
 */

import type { StrategyHypothesis } from "./types.js";

/** Minimal interface for reading existing strategies. */
export type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    definition: {
      id: string;
      symbols: string[];
      parameters: Record<string, number>;
    };
  }>;
};

/** Similarity threshold: below this normalized distance is considered a duplicate. */
const SIMILARITY_THRESHOLD = 0.15;

export class DeduplicationFilter {
  private registry: StrategyRegistryLike;

  constructor(registry: StrategyRegistryLike) {
    this.registry = registry;
  }

  /**
   * Filter hypotheses against existing strategies, returning only non-duplicates.
   * Also enforces the per-cycle rate limit.
   */
  filter(
    hypotheses: StrategyHypothesis[],
    maxPerCycle: number,
  ): {
    accepted: StrategyHypothesis[];
    rejected: Array<{ hypothesis: StrategyHypothesis; reason: string }>;
  } {
    const existing = this.registry.list();
    const accepted: StrategyHypothesis[] = [];
    const rejected: Array<{ hypothesis: StrategyHypothesis; reason: string }> = [];

    for (const h of hypotheses) {
      if (accepted.length >= maxPerCycle) {
        rejected.push({ hypothesis: h, reason: "rate_limit" });
        continue;
      }

      const dupReason = this.findDuplicate(h, existing);
      if (dupReason) {
        rejected.push({ hypothesis: h, reason: dupReason });
      } else {
        accepted.push(h);
      }
    }

    return { accepted, rejected };
  }

  /** Check if a hypothesis duplicates any existing strategy. */
  private findDuplicate(
    h: StrategyHypothesis,
    existing: Array<{
      id: string;
      name: string;
      definition: { id: string; symbols: string[]; parameters: Record<string, number> };
    }>,
  ): string | null {
    for (const s of existing) {
      // Exact match: same template + symbol
      if (s.definition.id === h.templateId && s.definition.symbols.includes(h.symbol)) {
        return `exact_match:${s.id}`;
      }

      // Parameter similarity check (only for same template)
      if (s.definition.id === h.templateId) {
        const distance = normalizedDistance(s.definition.parameters, h.parameters);
        if (distance < SIMILARITY_THRESHOLD) {
          return `similar_params:${s.id}(dist=${distance.toFixed(3)})`;
        }
      }
    }
    return null;
  }
}

/**
 * Compute normalized Euclidean distance between two parameter sets.
 * Parameters are normalized to [0, 1] using their combined range.
 */
function normalizedDistance(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;

  let sumSq = 0;
  let count = 0;

  for (const key of keys) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    // Normalize by max absolute value to avoid scale issues
    const maxAbs = Math.max(Math.abs(va), Math.abs(vb), 1);
    const diff = (va - vb) / maxAbs;
    sumSq += diff * diff;
    count++;
  }

  return Math.sqrt(sumSq / count);
}
