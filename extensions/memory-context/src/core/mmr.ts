/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Reduces redundancy in search results by penalizing candidates
 * that are too similar to already-selected items.
 *
 * MMR(d) = λ · Relevance(d) - (1-λ) · max(Similarity(d, d_selected))
 *
 * Where:
 *   λ (lambda) = trade-off between relevance and diversity (0.7 default)
 *   Relevance(d) = original hybrid search score (normalized)
 *   Similarity = cosine similarity between candidate vectors OR
 *                n-gram Jaccard similarity when vectors unavailable
 */

import { cosineSimilarity } from "./vector-index.js";

export type MMRCandidate<T> = {
  item: T;
  score: number;
  /** Embedding vector (if available). Falls back to content similarity if absent. */
  vector?: number[];
  /** Content string for fallback text-based similarity. */
  content?: string;
};

export type MMRConfig = {
  /** Trade-off: 1.0 = pure relevance, 0.0 = pure diversity. Default: 0.7 */
  lambda: number;
};

const DEFAULT_MMR_CONFIG: MMRConfig = { lambda: 0.7 };

/**
 * Compute n-gram Jaccard similarity between two strings.
 * Fast, no external dependencies. Used as fallback when vectors are unavailable.
 */
function ngramJaccard(a: string, b: string, n = 3): number {
  if (!a || !b) {
    return 0;
  }
  const getNgrams = (text: string): Set<string> => {
    const s = new Set<string>();
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    for (let i = 0; i <= normalized.length - n; i++) {
      s.add(normalized.slice(i, i + n));
    }
    return s;
  };

  const sa = getNgrams(a);
  const sb = getNgrams(b);
  if (sa.size === 0 || sb.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const g of sa) {
    if (sb.has(g)) {
      intersection++;
    }
  }
  return intersection / (sa.size + sb.size - intersection);
}

/**
 * Compute similarity between two candidates.
 * Prefers vector cosine similarity; falls back to n-gram Jaccard on content.
 */
function candidateSimilarity<T>(a: MMRCandidate<T>, b: MMRCandidate<T>): number {
  // Vector-based similarity (preferred)
  if (a.vector && b.vector && a.vector.length === b.vector.length && a.vector.length > 0) {
    return cosineSimilarity(a.vector, b.vector);
  }
  // Fallback: text-based n-gram Jaccard
  if (a.content && b.content) {
    return ngramJaccard(a.content, b.content);
  }
  return 0;
}

/**
 * Re-rank candidates using Maximal Marginal Relevance.
 *
 * @param candidates - Items with score and optional vector/content
 * @param limit - Max items to return
 * @param config - MMR parameters
 * @returns Re-ranked items (most relevant + diverse first)
 */
export function mmrRerank<T>(
  candidates: MMRCandidate<T>[],
  limit: number,
  config: MMRConfig = DEFAULT_MMR_CONFIG,
): T[] {
  if (candidates.length === 0) {
    return [];
  }
  if (candidates.length <= limit) {
    return candidates.map((c) => c.item);
  }

  const { lambda } = config;
  const remaining = [...candidates];

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...remaining.map((c) => c.score));
  const minScore = Math.min(...remaining.map((c) => c.score));
  const scoreRange = maxScore - minScore || 1;

  for (const c of remaining) {
    c.score = (c.score - minScore) / scoreRange;
  }

  const selected: MMRCandidate<T>[] = [];

  // Greedily select: pick the candidate with highest MMR score
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const sel of selected) {
        const sim = candidateSimilarity(candidate, sel);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }

      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    } else {
      break;
    }
  }

  return selected.map((c) => c.item);
}
