/**
 * Recall Module
 *
 * Retrieves memories using a hybrid scoring formula (7 channels):
 *
 *   Score = α·Vector + β·Recency + γ·Importance + δ·Graph + ε·Reinforcement
 *        + ζ·Temporal + η·Emotional
 *
 * This is significantly better than pure vector search because:
 * - Recent memories are boosted (recency decay)
 * - Important memories (0.9 vs 0.3) are weighted higher
 * - Memories connected to other entities in the graph get a bonus
 * - Temporal relevance: events close to today are boosted
 * - Emotional alignment: emotional context influences ranking
 *
 * Also enriches results with knowledge graph connections.
 */

import type { GraphDB } from "./graph.js";
import { parseDate } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  createdAt: number;
  recallCount?: number;
  /** ISO date string when the event happened (e.g. "2026-03-05") */
  happenedAt?: string | null;
  /** ISO date string when this fact expires */
  validUntil?: string | null;
  /** A concise LLM-generated summary (1 sentence, max 150 chars) of the fact */
  summary?: string | null;
  /** Emotional tone: stressed, happy, neutral, etc. */
  emotionalTone?: string | null;
  /** Emotional valence: -1.0 (negative) to 1.0 (positive) */
  emotionScore?: number | null;
}

export interface ScoredMemory {
  entry: MemoryEntry;
  vectorScore: number;
  recencyScore: number;
  importanceScore: number;
  graphScore: number;
  reinforcementScore: number;
  temporalScore: number;
  emotionalScore: number;
  finalScore: number;
}

// ============================================================================
// Scoring Weights
// ============================================================================

// Tunable weights for the hybrid scoring formula (7 channels)
const WEIGHTS = {
  vector: 0.42, // Semantic similarity is still king
  recency: 0.1, // Newer memories get a slight boost
  importance: 0.16, // User-defined or LLM-assigned importance
  graph: 0.08, // Graph connectivity bonus
  reinforcement: 0.08, // Frequently recalled memories are boosted
  temporal: 0.1, // Events close to "now" in time are boosted
  emotional: 0.06, // Emotional alignment bonus
};

// Recency decay: memories lose ~50% score after 30 days
const RECENCY_DECAY_RATE = 0.023; // -ln(0.5) / 30

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Calculate recency score using exponential decay.
 * Score = exp(-decay * daysSinceCreated)
 * - Just created: 1.0
 * - 7 days ago: ~0.85
 * - 30 days ago: ~0.50
 * - 90 days ago: ~0.12
 */
function recencyScore(createdAt: number): number {
  const now = Date.now();
  const daysSince = (now - createdAt) / (1000 * 60 * 60 * 24);
  return Math.exp(-RECENCY_DECAY_RATE * Math.max(0, daysSince));
}

/**
 * Calculate graph connectivity score for a memory text.
 * More graph connections = higher score.
 * Normalized to 0-1 range using: connections / (connections + 3)
 */
async function graphConnectivityScore(text: string, graphDB: GraphDB): Promise<number> {
  const edges = await graphDB.findEdgesForTexts([text], 20);
  if (edges.length === 0) return 0;
  // Soft normalization: 1 edge → 0.25, 3 edges → 0.5, 9 edges → 0.75
  return edges.length / (edges.length + 3);
}

/**
 * Calculate reinforcement score based on how often a memory has been recalled.
 * More recalls = stronger memory (like human brain).
 * Normalized: 1 recall → 0.25, 3 recalls → 0.5, 9 recalls → 0.75
 */
function reinforcementScore(recallCount: number): number {
  if (recallCount <= 0) return 0;
  return recallCount / (recallCount + 3);
}

/**
 * Calculate temporal relevance score.
 * Boost memories whose happenedAt is close to today.
 * Also penalize expired memories (validUntil < today).
 * Score 1.0 if happened today, decays over days.
 */
export function temporalRelevanceScore(entry: MemoryEntry): number {
  const now = Date.now();

  // If validUntil is set and has passed, heavily penalize
  if (entry.validUntil) {
    const expiry = parseDate(entry.validUntil);
    if (!isNaN(expiry) && expiry < now) {
      return 0.05; // Expired fact — near-zero but not invisible
    }
  }

  // If happenedAt is set, boost based on proximity to today
  if (entry.happenedAt) {
    const eventTime = parseDate(entry.happenedAt);
    if (!isNaN(eventTime)) {
      const daysDiff = Math.abs(now - eventTime) / (1000 * 60 * 60 * 24);
      // Same day → 1.0, 7 days → 0.5, 30 days → 0.14
      return 1 / (1 + daysDiff / 7);
    }
  }

  // No temporal data → neutral score (0.5)
  return 0.5;
}

/**
 * Calculate emotional alignment score.
 * Uses the absolute value of emotionScore as intensity.
 * Stronger emotions (positive or negative) get boosted.
 * Neutral → 0.3, Strong emotion → 0.8+
 */
export function emotionalAlignmentScore(entry: MemoryEntry): number {
  const score = entry.emotionScore;
  if (score == null || score === 0) return 0.3; // Neutral baseline
  // Use absolute intensity: |emotionScore|
  // Scale to 0.3–1.0 range: 0.3 + 0.7 * |score|
  return 0.3 + 0.7 * Math.abs(score);
}

// ============================================================================
// Hybrid Recall
// ============================================================================

/**
 * Apply hybrid scoring to raw vector search results.
 * Re-ranks results based on 7 signals, not just vector similarity.
 *
 * NOTE: The vectorScore here is derived from LanceDB's L2 distance via sim = 1/(1+d).
 * This is NOT cosine similarity. The consolidate module uses cosine similarity
 * for clustering — the two metrics have different scales, so thresholds are
 * not directly comparable between search and consolidation.
 */
export async function hybridScore(
  results: Array<{ entry: MemoryEntry; score: number }>,
  graphDB: GraphDB,
): Promise<ScoredMemory[]> {
  const scored = await Promise.all(
    results.map(async (r) => {
      const vs = r.score;
      const rs = recencyScore(r.entry.createdAt);
      const imp = r.entry.importance;
      const gs = await graphConnectivityScore(r.entry.text, graphDB);
      const rf = reinforcementScore(r.entry.recallCount ?? 0);
      const ts = temporalRelevanceScore(r.entry);
      const es = emotionalAlignmentScore(r.entry);

      const finalScore =
        WEIGHTS.vector * vs +
        WEIGHTS.recency * rs +
        WEIGHTS.importance * imp +
        WEIGHTS.graph * gs +
        WEIGHTS.reinforcement * rf +
        WEIGHTS.temporal * ts +
        WEIGHTS.emotional * es;

      return {
        entry: r.entry,
        vectorScore: vs,
        recencyScore: rs,
        importanceScore: imp,
        graphScore: gs,
        reinforcementScore: rf,
        temporalScore: ts,
        emotionalScore: es,
        finalScore,
      };
    }),
  );

  return scored.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Enrich recall results with knowledge graph connections.
 * Uses multi-hop traversal (2 hops) for deeper context.
 * Returns a human-readable string of graph relationships.
 */
export async function getGraphEnrichment(
  results: ScoredMemory[],
  graphDB: GraphDB,
): Promise<string> {
  // Find all texts from results (not just entities)
  const allTexts = results.map((r) => r.entry.text);

  // Step 1: Find direct edges matching result texts
  const directEdges = await graphDB.findEdgesForTexts(allTexts, 10);
  if (directEdges.length === 0) return "";

  // Step 2: Extract seed node IDs from direct edges
  const seedNodes = new Set<string>();
  for (const edge of directEdges) {
    seedNodes.add(edge.source);
    seedNodes.add(edge.target);
  }

  // Step 3: Traverse 2 hops from seed nodes for deeper context
  const traversal = await graphDB.traverse(Array.from(seedNodes), 2, 15);

  const lines = traversal.edges.map((e) => `- ${e.source} --[${e.relation}]--> ${e.target}`);

  return `\n\nKnowledge Graph Connections:\n${lines.join("\n")}`;
}
