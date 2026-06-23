// Memory Core plugin module implements hybrid behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

const log = createSubsystemLogger("memory/hybrid");

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

/**
 * One stage of the serial reranking pipeline. The manager resolves each
 * configured stage to a registered reranker adapter; `topK` narrows this
 * stage's output before it is handed to the next stage so slow downstream
 * rerankers only ever see a small candidate set.
 */
export type RerankStage = {
  adapter: RerankerAdapter;
  topK?: number;
  lambda?: number;
  /** Human-readable stage label (the configured provider id) for debug logs. */
  name?: string;
};

const DEFAULT_RERANK_STAGE_LAMBDA = 0.7;

const rerankerKey = (r: { path: string; startLine: number; endLine: number }): string =>
  `${r.path}:${r.startLine}-${r.endLine}`;

async function runReranker(
  adapter: RerankerAdapter,
  sorted: HybridMergedResult[],
  lambda: number,
): Promise<HybridMergedResult[] | null> {
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
  return out.length > 0 ? out : null;
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  /** Serial multi-stage reranking pipeline configuration. */
  rerank?: {
    enabled: boolean;
    /** Ordered, pre-resolved reranker stages (only installed plugins included). */
    stages: RerankStage[];
  };
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
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

  // Keep component scores as raw retrieval diagnostics; temporal decay and the
  // reranking pipeline only adjust or reorder the combined ranking score.
  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // Serial reranking pipeline: each stage reranks the prior stage's output, then
  // its top-K filter narrows survivors before the next stage runs. This keeps a
  // slow, precise reranker from ever seeing the full candidate set. A failed or
  // empty stage is skipped so reranking stays best-effort.
  if (params.rerank?.enabled && params.rerank.stages.length > 0) {
    let current = sorted;
    const stages = params.rerank.stages;
    log.debug("rerank pipeline start", { stages: stages.length, candidates: current.length });
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const lambda = stage.lambda ?? DEFAULT_RERANK_STAGE_LAMBDA;
      const stageLabel = stage.name ?? `stage-${i}`;
      const inputCount = current.length;
      let afterRerank = inputCount;
      // A stage counts as successful only when it returns a non-null result.
      // topK narrowing is tied to stage success: if the stage failed or returned
      // nothing, its topK must not be applied so the next stage (and the pipeline
      // output) sees the same input the failed stage received, not an arbitrary
      // head-slice of it.
      let stageSucceeded = false;
      try {
        const reranked = await runReranker(stage.adapter, current, lambda);
        if (reranked) {
          current = reranked;
          afterRerank = reranked.length;
          stageSucceeded = true;
        }
      } catch {
        // Stage failed; keep the prior ordering and continue with later stages.
      }
      // Narrow survivors for the next stage only when this stage succeeded. The
      // final stage's output is capped later by query.maxResults at the caller.
      const isLastStage = i === stages.length - 1;
      if (
        stageSucceeded &&
        !isLastStage &&
        stage.topK !== undefined &&
        stage.topK < current.length
      ) {
        current = current.slice(0, stage.topK);
      }
      // Surface how many candidates this stage removed so operators can see where
      // the pipeline narrows the working set before a slower downstream stage.
      log.debug("rerank stage filtered results", {
        stage: stageLabel,
        index: i,
        lambda,
        topK: stage.topK ?? null,
        inputCount,
        afterRerank,
        outputCount: current.length,
        filtered: inputCount - current.length,
        succeeded: stageSucceeded,
      });
    }
    log.debug("rerank pipeline complete", { candidates: current.length });
    return current;
  }

  return sorted;
}
