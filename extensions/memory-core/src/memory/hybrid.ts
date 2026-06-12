// Memory Core plugin module implements hybrid behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

type HybridSource = string;

type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export function buildFtsQuery(raw: string): string | null {
  const tokens = normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

type HybridMergedResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore: number;
  textScore: number;
  snippet: string;
  source: HybridSource;
};

export type RerankerAdapter = (
  items: Array<{ id: string; score: number; content: string }>,
  lambda: number,
) => Promise<Array<{ id: string; score: number; content: string }>>;

const rerankerKey = (r: { path: string; startLine: number; endLine: number }): string =>
  `${r.path}:${r.startLine}-${r.endLine}`;

async function runReranker(
  adapter: RerankerAdapter,
  sorted: HybridMergedResult[],
  lambda: number,
): Promise<HybridMergedResult[]> {
  const reranked = await adapter(
    sorted.map((r) => ({ id: rerankerKey(r), score: r.score, content: r.snippet })),
    lambda,
  );
  const byId = new Map(sorted.map((s) => [rerankerKey(s), s]));
  const out: HybridMergedResult[] = [];
  for (const r of reranked) {
    const original = byId.get(r.id);
    if (original) {
      out.push(original);
    }
  }
  return out;
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<{ enabled: boolean; lambda: number; provider: string; fallback: string }>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
  /** Reranker adapter for MMR re-ranking */
  reranker?: RerankerAdapter;
  /** Fallback reranker adapter if primary throws */
  fallbackReranker?: RerankerAdapter;
}): Promise<HybridMergedResult[]> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      vectorScore: entry.vectorScore,
      textScore: entry.textScore,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  // Keep component scores as raw retrieval diagnostics; temporal decay and MMR
  // only adjust or reorder the combined ranking score.
  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // Apply MMR re-ranking if enabled
  if (params.mmr?.enabled && (params.reranker || params.fallbackReranker)) {
    const lambda = params.mmr.lambda ?? 0.7;
    if (params.reranker) {
      try {
        return await runReranker(params.reranker, sorted, lambda);
      } catch {
        // primary failed; fall through to fallback
      }
    }
    if (params.fallbackReranker) {
      try {
        return await runReranker(params.fallbackReranker, sorted, lambda);
      } catch {
        return sorted;
      }
    }
    return sorted;
  }

  return sorted;
}
