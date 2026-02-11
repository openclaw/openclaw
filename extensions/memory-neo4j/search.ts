/**
 * Three-signal hybrid search with query-adaptive RRF fusion.
 *
 * Combines:
 *   Signal 1: Vector similarity (HNSW cosine)
 *   Signal 2: BM25 full-text keyword matching
 *   Signal 3: Graph traversal (entity → MENTIONS ← memory)
 *
 * Fused using confidence-weighted Reciprocal Rank Fusion (RRF)
 * with query-adaptive signal weights.
 *
 * Adapted from ontology project RRF implementation.
 */

import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { HybridSearchResult, Logger, SearchSignalResult } from "./schema.js";

// ============================================================================
// Query Classification
// ============================================================================

export type QueryType = "short" | "entity" | "long" | "default";

/**
 * Classify a query to determine adaptive signal weights.
 *
 * - short (1-2 words): BM25 excels at exact keyword matching
 * - entity (proper nouns detected): Graph traversal finds connected memories
 * - long (5+ words): Vector captures semantic intent better
 * - default: balanced weights
 */
export function classifyQuery(query: string): QueryType {
  const words = query.trim().split(/\s+/);
  const wordCount = words.length;

  // Entity detection: check for capitalized words (proper nouns)
  // Runs before word count so "John" or "TypeScript" are classified as entity
  const commonWords =
    /^(I|A|An|The|Is|Are|Was|Were|What|Who|Where|When|How|Why|Do|Does|Did|Find|Show|Get|Tell|Me|My|About|For)$/;
  const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w) && !commonWords.test(w));

  if (capitalizedWords.length > 0) {
    return "entity";
  }

  // Short queries: 1-2 words → boost BM25
  if (wordCount <= 2) {
    return "short";
  }

  // Question patterns targeting entities (3-4 word queries only,
  // so generic long questions like "what is the best framework" fall through to "long")
  if (wordCount <= 4 && /^(who|where|what)\s+(is|does|did|was|were)\s/i.test(query)) {
    return "entity";
  }

  // Long queries: 5+ words → boost vector
  if (wordCount >= 5) {
    return "long";
  }

  return "default";
}

/**
 * Get adaptive signal weights based on query type.
 * Returns [vectorWeight, bm25Weight, graphWeight].
 *
 * Decision Q7: Query-adaptive RRF weights
 * - Short → boost BM25 (keyword matching)
 * - Entity → boost graph (relationship traversal)
 * - Long → boost vector (semantic similarity)
 */
export function getAdaptiveWeights(
  queryType: QueryType,
  graphEnabled: boolean,
): [number, number, number] {
  const graphBase = graphEnabled ? 1.0 : 0.0;

  switch (queryType) {
    case "short":
      return [0.8, 1.2, graphBase * 1.0];
    case "entity":
      return [0.8, 1.0, graphBase * 1.3];
    case "long":
      return [1.2, 0.7, graphBase * 0.8];
    case "default":
    default:
      return [1.0, 1.0, graphBase * 1.0];
  }
}

// ============================================================================
// Confidence-Weighted RRF Fusion
// ============================================================================

type SignalEntry = {
  rank: number; // 1-indexed
  score: number; // 0-1 normalized
};

type FusedCandidate = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  rrfScore: number;
};

/**
 * Fuse multiple search signals using confidence-weighted RRF.
 *
 * Formula: RRF_conf(d) = Σ w_i × score_i(d) / (k + rank_i(d))
 *
 * Unlike standard RRF which only uses ranks, this variant preserves
 * score magnitude: rank-1 with score 0.99 contributes more than
 * rank-1 with score 0.55.
 *
 * Reference: Cormack et al. (2009), extended with confidence weighting.
 */
export function fuseWithConfidenceRRF(
  signals: SearchSignalResult[][],
  k: number,
  weights: number[],
): FusedCandidate[] {
  // Build per-signal rank/score lookups
  const signalMaps: Map<string, SignalEntry>[] = signals.map((signal) => {
    const map = new Map<string, SignalEntry>();
    for (let i = 0; i < signal.length; i++) {
      const entry = signal[i];
      // If duplicate in same signal, keep first (higher ranked)
      if (!map.has(entry.id)) {
        map.set(entry.id, { rank: i + 1, score: entry.score });
      }
    }
    return map;
  });

  // Collect all unique candidate IDs with their metadata
  const candidateMetadata = new Map<
    string,
    { text: string; category: string; importance: number; createdAt: string }
  >();

  for (const signal of signals) {
    for (const entry of signal) {
      if (!candidateMetadata.has(entry.id)) {
        candidateMetadata.set(entry.id, {
          text: entry.text,
          category: entry.category,
          importance: entry.importance,
          createdAt: entry.createdAt,
        });
      }
    }
  }

  // Calculate confidence-weighted RRF score for each candidate
  const results: FusedCandidate[] = [];

  for (const [id, meta] of candidateMetadata) {
    let rrfScore = 0;

    for (let i = 0; i < signalMaps.length; i++) {
      const entry = signalMaps[i].get(id);
      if (entry && entry.rank > 0) {
        // Confidence-weighted: multiply by original score
        rrfScore += weights[i] * entry.score * (1 / (k + entry.rank));
      }
    }

    results.push({
      id,
      text: meta.text,
      category: meta.category,
      importance: meta.importance,
      createdAt: meta.createdAt,
      rrfScore,
    });
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

// ============================================================================
// Hybrid Search Orchestrator
// ============================================================================

/**
 * Perform a three-signal hybrid search with query-adaptive RRF fusion.
 *
 * 1. Embed the query
 * 2. Classify query for adaptive weights
 * 3. Run three signals in parallel
 * 4. Fuse with confidence-weighted RRF
 * 5. Return top results
 *
 * Graceful degradation: if any signal fails, RRF works with remaining signals.
 * If graph search is not enabled (no extraction API key), uses 2-signal fusion.
 */
export async function hybridSearch(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  query: string,
  limit: number = 5,
  agentId: string = "default",
  graphEnabled: boolean = false,
  options: {
    rrfK?: number;
    candidateMultiplier?: number;
    graphFiringThreshold?: number;
    graphSearchDepth?: number;
    logger?: Logger;
  } = {},
): Promise<HybridSearchResult[]> {
  // Guard against empty queries
  if (!query.trim()) {
    return [];
  }

  const {
    rrfK = 60,
    candidateMultiplier = 4,
    graphFiringThreshold = 0.3,
    graphSearchDepth = 1,
    logger,
  } = options;

  const candidateLimit = Math.floor(Math.min(200, Math.max(1, limit * candidateMultiplier)));

  // 1. Generate query embedding
  const t0 = performance.now();
  const queryEmbedding = await embeddings.embed(query);
  const tEmbed = performance.now();

  // 2. Classify query and get adaptive weights
  const queryType = classifyQuery(query);
  const weights = getAdaptiveWeights(queryType, graphEnabled);

  // 3. Run signals in parallel
  const [vectorResults, bm25Results, graphResults] = await Promise.all([
    db.vectorSearch(queryEmbedding, candidateLimit, 0.1, agentId),
    db.bm25Search(query, candidateLimit, agentId),
    graphEnabled
      ? db.graphSearch(query, candidateLimit, graphFiringThreshold, agentId, graphSearchDepth)
      : Promise.resolve([] as SearchSignalResult[]),
  ]);
  const tSignals = performance.now();

  // 4. Fuse with confidence-weighted RRF
  const fused = fuseWithConfidenceRRF([vectorResults, bm25Results, graphResults], rrfK, weights);
  const tFuse = performance.now();

  // 5. Return top results, normalized to 0-100% display scores.
  // Only normalize when maxRrf is above a minimum threshold to avoid
  // inflating weak matches (e.g., a single low-score result becoming 1.0).
  const maxRrf = fused.length > 0 ? fused[0].rrfScore : 0;
  const MIN_RRF_FOR_NORMALIZATION = 0.01;
  const normalizer = maxRrf >= MIN_RRF_FOR_NORMALIZATION ? 1 / maxRrf : 1;

  const results = fused.slice(0, limit).map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category,
    importance: r.importance,
    createdAt: r.createdAt,
    score: Math.min(1, r.rrfScore * normalizer), // Normalize to 0-1
  }));

  // 6. Record retrieval events (fire-and-forget for latency)
  // This tracks which memories are actually being used, enabling
  // retrieval-based importance adjustment and promotion criteria.
  if (results.length > 0) {
    const memoryIds = results.map((r) => r.id);
    db.recordRetrievals(memoryIds).catch(() => {
      // Silently ignore - retrieval tracking is non-critical
    });
  }

  // Log search timing breakdown
  logger?.info?.(
    `memory-neo4j: [bench] hybridSearch ${(tFuse - t0).toFixed(0)}ms (embed=${(tEmbed - t0).toFixed(0)}ms, signals=${(tSignals - tEmbed).toFixed(0)}ms, fuse=${(tFuse - tSignals).toFixed(0)}ms) ` +
      `type=${queryType} vec=${vectorResults.length} bm25=${bm25Results.length} graph=${graphResults.length} → ${results.length} results`,
  );

  return results;
}
