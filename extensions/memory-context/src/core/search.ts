import { selectWithinBudget, type BudgetSegment } from "./budget.js";
import type { SearchConfig, BudgetConfig } from "./config.js";
import type { SegmentSearchResult, WarmStore } from "./store.js";

export type HybridSearchResult = SegmentSearchResult & {
  vectorScore: number;
  bm25Score: number;
};

/**
 * Calculate time decay factor.
 * score *= decay^(days_since_message)
 */
export function calculateTimeDecay(timestamp: number, now: number, decay: number): number {
  if (decay >= 1) {
    return 1;
  }
  if (decay <= 0) {
    return 0;
  }

  const daysSince = Math.max(0, (now - timestamp) / (1000 * 60 * 60 * 24));
  return Math.pow(decay, daysSince);
}

/**
 * Normalize BM25 scores to 0-1 range.
 * Uses max normalization.
 */
function normalizeBM25Scores(results: Array<{ id: string; score: number }>): Map<string, number> {
  const map = new Map<string, number>();
  if (results.length === 0) {
    return map;
  }

  const maxScore = Math.max(...results.map((r) => r.score));
  if (maxScore <= 0) {
    return map;
  }

  for (const r of results) {
    map.set(r.id, r.score / maxScore);
  }
  return map;
}

/**
 * Perform hybrid search combining vector and BM25 results.
 */
export function hybridSearch(
  vectorResults: SegmentSearchResult[],
  bm25Results: Array<{ id: string; score: number }>,
  config: SearchConfig,
  getSegment: (id: string) => SegmentSearchResult["segment"] | undefined,
  now = Date.now(),
): HybridSearchResult[] {
  const { vectorWeight, bm25Weight, timeDecay } = config;

  // Normalize BM25 scores to 0-1
  const bm25Scores = normalizeBM25Scores(bm25Results);

  // Merge results
  const merged = new Map<string, HybridSearchResult>();

  // Add vector results
  for (const vr of vectorResults) {
    const bm25Score = bm25Scores.get(vr.segment.id) ?? 0;
    const rawScore = vectorWeight * vr.score + bm25Weight * bm25Score;
    const decayFactor = calculateTimeDecay(vr.segment.timestamp, now, timeDecay);
    const score = rawScore * decayFactor;

    merged.set(vr.segment.id, {
      segment: vr.segment,
      score,
      vectorScore: vr.score,
      bm25Score,
    });
  }

  // Add BM25-only results (not in vector results)
  for (const [id, rawBm25Score] of bm25Scores) {
    if (merged.has(id)) {
      continue;
    }

    const segment = getSegment(id);
    if (!segment) {
      continue;
    }

    const bm25Score = rawBm25Score;
    const rawScore = bm25Weight * bm25Score;
    const decayFactor = calculateTimeDecay(segment.timestamp, now, timeDecay);
    const score = rawScore * decayFactor;

    merged.set(id, {
      segment,
      score,
      vectorScore: 0,
      bm25Score,
    });
  }

  // Sort by combined score
  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);

  return results;
}

export function formatSearchResults(results: SegmentSearchResult[]): {
  text: string;
  sanitized: Array<{ id: string; role: string; content: string; timestamp: number; score: number }>;
} {
  const sanitized = results.map((r) => ({
    id: r.segment.id,
    role: r.segment.role,
    content: r.segment.content,
    timestamp: r.segment.timestamp,
    score: r.score,
  }));

  if (results.length === 0) {
    return { text: "No relevant conversation history found.", sanitized: [] };
  }

  const lines = results.map((r, i) => {
    const when = new Date(r.segment.timestamp).toISOString();
    const snippet =
      r.segment.content.length > 200 ? `${r.segment.content.slice(0, 200)}…` : r.segment.content;
    return `${i + 1}. (${(r.score * 100).toFixed(0)}%) [${r.segment.role}] ${when}\n   ${snippet}`;
  });

  return {
    text: `Found ${results.length} matching segments:\n\n${lines.join("\n\n")}`,
    sanitized,
  };
}

export function formatConversationHistoryBlock(
  results: SegmentSearchResult[],
  opts: { maxTokens: number },
): { block: string; usedTokens: number; included: number } {
  const maxTokens = Math.max(0, Math.floor(opts.maxTokens));
  let usedTokens = 0;
  const selected: SegmentSearchResult[] = [];

  for (const r of results) {
    const t = r.segment.tokens;
    if (selected.length > 0 && usedTokens + t > maxTokens) {
      break;
    }
    if (selected.length === 0 && t > maxTokens) {
      // Always allow at least one entry; truncate by tokens is hard.
      selected.push(r);
      usedTokens += Math.min(t, maxTokens);
      break;
    }
    selected.push(r);
    usedTokens += t;
  }

  const lines = selected.map((r) => {
    const when = new Date(r.segment.timestamp).toISOString();
    const content = r.segment.content.replace(/\s+/g, " ").trim();
    return `- [${r.segment.role} @ ${when}] ${content}`;
  });

  const block =
    selected.length === 0
      ? ""
      : `<conversation-history>\nThe following conversation history may be relevant:\n${lines.join("\n")}\n</conversation-history>`;

  return { block, usedTokens, included: selected.length };
}

/**
 * Format results with budget manager.
 */
export function formatWithBudget(
  results: SegmentSearchResult[],
  budgetConfig: BudgetConfig,
): { block: string; usedTokens: number; included: number; truncated: number } {
  // Convert to BudgetSegment
  const candidates: BudgetSegment[] = results.map((r) => ({
    id: r.segment.id,
    content: r.segment.content,
    timestamp: r.segment.timestamp,
    score: r.score,
  }));

  const { segments, usedTokens, count, truncated } = selectWithinBudget(candidates, budgetConfig);

  if (segments.length === 0) {
    return { block: "", usedTokens: 0, included: 0, truncated };
  }

  // Find original results to get role info
  const resultMap = new Map(results.map((r) => [r.segment.id, r]));

  const lines = segments.map((seg) => {
    const r = resultMap.get(seg.id);
    const role = r?.segment.role ?? "user";
    const when = new Date(seg.timestamp).toISOString();
    const content = seg.content.replace(/\s+/g, " ").trim();
    return `- [${role} @ ${when}] ${content}`;
  });

  const block = `<conversation-history>\nThe following conversation history may be relevant:\n${lines.join("\n")}\n</conversation-history>`;

  return { block, usedTokens, included: count, truncated };
}

export async function autoRecall(
  store: WarmStore,
  prompt: string,
  opts: { limit: number; minScore: number; maxTokens: number },
  searchConfig?: SearchConfig,
  budgetConfig?: BudgetConfig,
): Promise<string | undefined> {
  if (!prompt || prompt.trim().length < 3) {
    return;
  }

  let results: SegmentSearchResult[];

  if (searchConfig) {
    results = await store.hybridSearch(prompt, opts.limit * 2, opts.minScore, searchConfig);
  } else {
    results = await store.search(prompt, opts.limit, opts.minScore);
  }

  // Filter by minScore (hybrid search may return lower scores)
  results = results.filter((r) => r.score >= opts.minScore);

  if (budgetConfig) {
    const { block } = formatWithBudget(results, budgetConfig);
    return block || undefined;
  }

  const { block } = formatConversationHistoryBlock(results, { maxTokens: opts.maxTokens });
  return block || undefined;
}
