/**
 * Context Budget Manager
 *
 * Manages token budget for context injection.
 * Uses greedy selection (by score) then reorders by time.
 */

export type BudgetSegment = {
  id: string;
  content: string;
  timestamp: number;
  score: number;
};

export type BudgetConfig = {
  /** Maximum tokens allowed */
  maxTokens: number;
  /** Characters per token estimate (default: 3) */
  tokenEstimateRatio: number;
};

export type BudgetResult = {
  /** Selected segments, sorted by timestamp (oldest first) */
  segments: BudgetSegment[];
  /** Total estimated tokens used */
  usedTokens: number;
  /** Number of segments selected */
  count: number;
  /** Number of segments that were cut due to budget */
  truncated: number;
};

/**
 * Estimate token count for text.
 * Rough heuristic: Chinese ~1-2 tokens per char, English ~1 token per 4 chars.
 * We use a simple ratio for both.
 */
export function estimateTokens(text: string, ratio = 3): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / ratio));
}

/**
 * Select segments within budget using greedy strategy.
 *
 * Algorithm:
 * 1. Input segments are assumed to be sorted by score (best first)
 * 2. Greedily add segments until budget is exhausted
 * 3. Re-sort selected segments by timestamp (oldest first)
 *
 * @param candidates - Segments sorted by score (best first)
 * @param config - Budget configuration
 * @returns Selected segments sorted by timestamp
 */
export function selectWithinBudget(
  candidates: BudgetSegment[],
  config: BudgetConfig,
): BudgetResult {
  const { maxTokens, tokenEstimateRatio } = config;

  if (maxTokens <= 0 || candidates.length === 0) {
    return { segments: [], usedTokens: 0, count: 0, truncated: candidates.length };
  }

  const selected: BudgetSegment[] = [];
  let usedTokens = 0;
  let truncated = 0;

  for (const seg of candidates) {
    const segTokens = estimateTokens(seg.content, tokenEstimateRatio);

    // Always include at least one segment if we have none
    if (selected.length === 0) {
      selected.push(seg);
      usedTokens += segTokens;
      continue;
    }

    // Check if adding this segment would exceed budget
    if (usedTokens + segTokens > maxTokens) {
      truncated++;
      continue;
    }

    selected.push(seg);
    usedTokens += segTokens;
  }

  // Also count remaining candidates as truncated
  truncated = candidates.length - selected.length;

  // Sort by timestamp (oldest first) to maintain conversation flow
  selected.sort((a, b) => a.timestamp - b.timestamp);

  return {
    segments: selected,
    usedTokens,
    count: selected.length,
    truncated,
  };
}

/**
 * Convenience class for Budget Manager.
 */
export class BudgetManager {
  constructor(private readonly config: BudgetConfig) {}

  /**
   * Select segments within budget.
   */
  select(candidates: BudgetSegment[]): BudgetResult {
    return selectWithinBudget(candidates, this.config);
  }

  /**
   * Estimate tokens for text.
   */
  estimateTokens(text: string): number {
    return estimateTokens(text, this.config.tokenEstimateRatio);
  }

  /**
   * Check if text fits within remaining budget.
   */
  fits(text: string, usedTokens: number): boolean {
    return usedTokens + this.estimateTokens(text) <= this.config.maxTokens;
  }
}
