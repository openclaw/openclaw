// Memory Core plugin module implements mmr behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jaccardSimilarity, tokenize } from "./tokenize.js";

/**
 * Maximal Marginal Relevance (MMR) re-ranking algorithm.
 *
 * MMR balances relevance with diversity by iteratively selecting results
 * that maximize: λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 */

type MMRItem = {
  score: number;
  snippet: string;
};

export type MMRConfig = {
  /** Enable/disable MMR re-ranking. Default: false (opt-in) */
  enabled: boolean;
  /** Lambda parameter: 0 = max diversity, 1 = max relevance. Default: 0.7 */
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

/**
 * Compute MMR score for a candidate item.
 * MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 */
function computeMMRScore(relevance: number, maxSimilarity: number, lambda: number): number {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

type PreparedMMRItem<T extends MMRItem> = {
  item: T;
  score: number;
  tokens: Set<string>;
  emptyTokenText: string | undefined;
  relevance: number;
  maxSimilarity: number;
};

/**
 * Re-rank items using Maximal Marginal Relevance (MMR).
 *
 * The algorithm iteratively selects items that balance relevance with diversity:
 * 1. Start with the highest-scoring item
 * 2. For each remaining slot, select the item that maximizes the MMR score
 * 3. MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
 *
 * @param items - Items to re-rank, must have score and snippet
 * @param config - MMR configuration (lambda, enabled)
 * @returns Re-ranked items in MMR order
 */
function mmrRerank<T extends MMRItem>(items: T[], config: Partial<MMRConfig> = {}): T[] {
  const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config;
  if (!enabled || items.length <= 1) {
    return [...items];
  }
  const clampedLambda = Math.max(0, Math.min(1, lambda));
  if (clampedLambda === 1) {
    return [...items].toSorted((a, b) => b.score - a.score);
  }
  const prepared: PreparedMMRItem<T>[] = items.map((item) => {
    const snippet = item.snippet;
    const tokens = tokenize(snippet);
    return {
      item,
      score: item.score,
      tokens,
      emptyTokenText: tokens.size === 0 ? normalizeLowercaseStringOrEmpty(snippet) : undefined,
      relevance: 0,
      maxSimilarity: 0,
    };
  });
  const maxScore = Math.max(...prepared.map((item) => item.score));
  const minScore = Math.min(...prepared.map((item) => item.score));
  const scoreRange = maxScore - minScore;
  for (const item of prepared) {
    item.relevance = scoreRange === 0 ? 1 : (item.score - minScore) / scoreRange;
  }
  const remaining = new Set(prepared);
  const selected: T[] = [];
  while (remaining.size > 0) {
    let bestItem: PreparedMMRItem<T> | null = null;
    let bestMMRScore = -Infinity;
    for (const candidate of remaining) {
      const mmrScore = computeMMRScore(candidate.relevance, candidate.maxSimilarity, clampedLambda);
      if (
        mmrScore > bestMMRScore ||
        (mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity))
      ) {
        bestMMRScore = mmrScore;
        bestItem = candidate;
      }
    }
    if (!bestItem) {
      break;
    }
    selected.push(bestItem.item);
    remaining.delete(bestItem);
    // A selected item's contribution never changes, so update each candidate's
    // running maximum once per pair instead of rescanning selected items.
    for (const candidate of remaining) {
      const similarity =
        candidate.tokens.size === 0 && bestItem.tokens.size === 0
          ? Number(candidate.emptyTokenText === bestItem.emptyTokenText)
          : jaccardSimilarity(candidate.tokens, bestItem.tokens);
      if (similarity > candidate.maxSimilarity) {
        candidate.maxSimilarity = similarity;
      }
    }
  }
  return selected;
}

/**
 * Apply MMR re-ranking to hybrid search results.
 */
export function applyMMRToHybridResults<
  T extends { score: number; snippet: string; path: string; startLine: number },
>(results: T[], config: Partial<MMRConfig> = {}): T[] {
  if (results.length === 0) {
    return results;
  }
  return mmrRerank(results, config);
}
