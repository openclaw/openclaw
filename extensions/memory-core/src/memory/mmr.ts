import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jaccardSimilarity, tokenize } from "./tokenize.js";

// Carbonell & Goldstein (1998): maximize λ * relevance - (1-λ) * similarity.

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

type PreparedMMRItem<T extends MMRItem> = {
  item: T;
  score: number;
  tokens: Set<string>;
  emptyTokenText: string | undefined;
  relevance: number;
  maxSimilarity: number;
};

export function applyMMRToHybridResults<T extends MMRItem & { path: string; startLine: number }>(
  items: T[],
  config: Partial<MMRConfig> = {},
): T[] {
  if (items.length === 0) {
    return items;
  }
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
      const mmrScore =
        clampedLambda * candidate.relevance - (1 - clampedLambda) * candidate.maxSimilarity;
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
