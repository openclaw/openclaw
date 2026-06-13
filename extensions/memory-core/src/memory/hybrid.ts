// Memory Core plugin module implements hybrid behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
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

/**
 * Check if two line ranges overlap.
 */
function linesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
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
    }
  >();

  // Secondary index: group vector results by path for fallback matching
  const vectorByPath = new Map<string, HybridVectorResult[]>();

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
    const existing = vectorByPath.get(r.path);
    if (existing) {
      existing.push(r);
    } else {
      vectorByPath.set(r.path, [r]);
    }
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      // Exact chunk ID match — update textScore directly
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      // No chunk ID match — try path + line range overlap as fallback
      // Pick the overlapping vector chunk with the highest vectorScore
      const candidates = vectorByPath.get(r.path);
      let merged = false;
      if (candidates) {
        let best: HybridVectorResult | undefined;
        for (const v of candidates) {
          if (linesOverlap(r.startLine, r.endLine, v.startLine, v.endLine)) {
            if (!best || v.vectorScore > best.vectorScore) {
              best = v;
            }
          }
        }
        if (best) {
          const entry = byId.get(best.id)!;
          entry.textScore = Math.max(entry.textScore, r.textScore);
          if (r.startLine < entry.startLine) entry.startLine = r.startLine;
          if (r.endLine > entry.endLine) entry.endLine = r.endLine;
          if (r.snippet && r.snippet.length > 0) {
            entry.snippet = r.snippet;
          }
          merged = true;
        }
      }
      if (!merged) {
        // No overlap found — add as keyword-only entry
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
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) {
    return applyMMRToHybridResults(sorted, mmrConfig);
  }

  return sorted;
}
