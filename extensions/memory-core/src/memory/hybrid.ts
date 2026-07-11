// Memory Core plugin module implements hybrid behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyMMRToHybridResults, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

type HybridSource = string;
type ExactPathSpecificity = 0 | 1 | 2 | 3;

type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
  exactPathSpecificity?: ExactPathSpecificity;
};

type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
  pathScore?: number;
  exactPathSpecificity?: ExactPathSpecificity;
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

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
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
      pathScore: number;
      exactPathSpecificity: ExactPathSpecificity;
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
      pathScore: 0,
      exactPathSpecificity: r.exactPathSpecificity ?? 0,
    });
  }

  for (const r of params.keyword) {
    const exactPathSpecificity = r.exactPathSpecificity ?? 0;
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      existing.pathScore = r.pathScore ?? 0;
      existing.exactPathSpecificity = Math.max(
        existing.exactPathSpecificity,
        exactPathSpecificity,
      ) as ExactPathSpecificity;
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
        pathScore: r.pathScore ?? 0,
        exactPathSpecificity,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const weightedContentScore =
      params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    const hasWeightedContentRelevance = weightedContentScore > 0;
    // Exact specificity already carries path precedence. Keep body scores as
    // the within-tier signal, and use path BM25 only for partial path-only hits.
    const keywordScore =
      entry.exactPathSpecificity > 0 || entry.textScore > 0 ? entry.textScore : entry.pathScore;
    // Exact path-only hits share one recency baseline. Content-backed hits stay
    // in the stronger tie class and retain their weighted relevance.
    const exactPathOnly = entry.exactPathSpecificity > 0 && !hasWeightedContentRelevance;
    const weightedScore = exactPathOnly
      ? 1
      : params.vectorWeight * entry.vectorScore + params.textWeight * keywordScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: weightedScore,
      vectorScore: entry.vectorScore,
      textScore: entry.textScore,
      exactPathSpecificity: entry.exactPathSpecificity,
      hasWeightedContentRelevance,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  // Keep component scores as raw retrieval diagnostics. Temporal decay and MMR
  // may adjust the combined score, but cannot cross the exact-identifier tier.
  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const rankable = decayed.map((entry) => {
    // Specificity owns cross-tier precedence. Keep the decayed weighted score
    // separately for within-tier ranking while exact public scores stay at 1.
    const exactPathTieScore = entry.score;
    return Object.assign(entry, {
      exactPathTieScore,
      score: entry.exactPathSpecificity > 0 ? 1 : entry.score,
    });
  });
  const nonExact = rankable
    .filter((entry) => entry.exactPathSpecificity === 0)
    .toSorted((a, b) => b.score - a.score);

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  const rerankExactGroup = (entries: typeof rankable) => {
    if (!mmrConfig.enabled) {
      return entries;
    }
    return applyMMRToHybridResults(
      entries.map((entry) => Object.assign(entry, { score: entry.exactPathTieScore })),
      mmrConfig,
    ).map((entry) => Object.assign(entry, { score: 1 }));
  };
  const compareExactTieScores = (a: (typeof rankable)[number], b: (typeof rankable)[number]) =>
    b.exactPathTieScore - a.exactPathTieScore ||
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine;
  const exact = ([3, 2, 1] as const).flatMap((specificity) => {
    const tier = rankable.filter((entry) => entry.exactPathSpecificity === specificity);
    const contentBacked = tier
      .filter((entry) => entry.hasWeightedContentRelevance)
      .toSorted(compareExactTieScores);
    const pathOnly = tier
      .filter((entry) => !entry.hasWeightedContentRelevance)
      .toSorted(compareExactTieScores);
    return rerankExactGroup(contentBacked).concat(rerankExactGroup(pathOnly));
  });
  const ranked = [
    ...exact,
    ...(mmrConfig.enabled ? applyMMRToHybridResults(nonExact, mmrConfig) : nonExact),
  ];

  return ranked.map(
    ({
      exactPathSpecificity: _exactPathSpecificity,
      exactPathTieScore: _exactPathTieScore,
      hasWeightedContentRelevance: _hasWeightedContentRelevance,
      ...entry
    }) => entry,
  );
}
