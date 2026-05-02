import { applyMMRToHybridResults, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
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

export type HybridFusionMode = "weighted" | "rrf";

/** Fixed RRF constant `k`; fusion formula is documented in `docs/reference/memory-rrf-contract.md`. */
const DEFAULT_RRF_K = 60;

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
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

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  fusion?: HybridFusionMode;
  workspaceDir?: string;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<
  Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    vectorScore: number;
    textScore: number;
    snippet: string;
    source: HybridSource;
  }>
> {
  const fusion: HybridFusionMode = params.fusion ?? "weighted";
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
      vectorRank: number | null;
      textRank: number | null;
    }
  >();

  for (const [idx, r] of params.vector.entries()) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
      vectorRank: idx + 1,
      textRank: null,
    });
  }

  for (const [idx, r] of params.keyword.entries()) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      existing.textRank = idx + 1;
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
        vectorRank: null,
        textRank: idx + 1,
      });
    }
  }

  const weightSum = params.vectorWeight + params.textWeight;
  const rrfNormalizeScale = fusion === "rrf" && weightSum > 0 ? (DEFAULT_RRF_K + 1) / weightSum : 1;

  const merged = Array.from(byId.values()).map((entry) => {
    const rawRrfScore =
      (entry.vectorRank ? params.vectorWeight / (DEFAULT_RRF_K + entry.vectorRank) : 0) +
      (entry.textRank ? params.textWeight / (DEFAULT_RRF_K + entry.textRank) : 0);
    const score =
      fusion === "rrf"
        ? rawRrfScore * rrfNormalizeScale
        : params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
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
  const sorted = decayed.toSorted((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine;
    }
    if (a.endLine !== b.endLine) {
      return a.endLine - b.endLine;
    }
    return a.source.localeCompare(b.source);
  });

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) {
    return applyMMRToHybridResults(sorted, mmrConfig);
  }

  return sorted;
}
