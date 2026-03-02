/**
 * Recall Module
 *
 * Retrieves memories using a hybrid scoring formula:
 *
 *   Score = α·VectorSimilarity + β·Recency + γ·Importance + δ·GraphConnections
 *
 * This is significantly better than pure vector search because:
 * - Recent memories are boosted (recency decay)
 * - Important memories (0.9 vs 0.3) are weighted higher
 * - Memories connected to other entities in the graph get a bonus
 *
 * Also enriches results with knowledge graph connections.
 */

import type { GraphDB } from "./graph.js";

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
  recallCount?: number; // How many times this memory was recalled (reinforcement)
}

export interface ScoredMemory {
  entry: MemoryEntry;
  vectorScore: number;
  recencyScore: number;
  importanceScore: number;
  graphScore: number;
  reinforcementScore: number;
  finalScore: number;
}

// ============================================================================
// Scoring Weights
// ============================================================================

// Tunable weights for the hybrid scoring formula (5 channels)
const WEIGHTS = {
  vector: 0.50, // Semantic similarity is still king
  recency: 0.12, // Newer memories get a slight boost
  importance: 0.18, // User-defined or LLM-assigned importance
  graph: 0.10, // Graph connectivity bonus
  reinforcement: 0.10, // Frequently recalled memories are boosted
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
function graphConnectivityScore(
  text: string,
  graphDB: GraphDB,
): number {
  const edges = graphDB.findEdgesForTexts([text], 20);
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

// ============================================================================
// Hybrid Recall
// ============================================================================

/**
 * Apply hybrid scoring to raw vector search results.
 * Re-ranks results based on 5 signals, not just vector similarity.
 */
export function hybridScore(
  results: Array<{ entry: MemoryEntry; score: number }>,
  graphDB: GraphDB,
): ScoredMemory[] {
  return results
    .map((r) => {
      const vs = r.score;
      const rs = recencyScore(r.entry.createdAt);
      const imp = r.entry.importance;
      const gs = graphConnectivityScore(r.entry.text, graphDB);
      const rf = reinforcementScore(r.entry.recallCount ?? 0);

      const finalScore =
        WEIGHTS.vector * vs +
        WEIGHTS.recency * rs +
        WEIGHTS.importance * imp +
        WEIGHTS.graph * gs +
        WEIGHTS.reinforcement * rf;

      return {
        entry: r.entry,
        vectorScore: vs,
        recencyScore: rs,
        importanceScore: imp,
        graphScore: gs,
        reinforcementScore: rf,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Enrich recall results with knowledge graph connections.
 * Uses multi-hop traversal (2 hops) for deeper context.
 * Returns a human-readable string of graph relationships.
 */
export function getGraphEnrichment(
  results: ScoredMemory[],
  graphDB: GraphDB,
): string {
  // Find all texts from results (not just entities)
  const allTexts = results.map((r) => r.entry.text);

  // Step 1: Find direct edges matching result texts
  const directEdges = graphDB.findEdgesForTexts(allTexts, 10);
  if (directEdges.length === 0) return "";

  // Step 2: Extract seed node IDs from direct edges
  const seedNodes = new Set<string>();
  for (const edge of directEdges) {
    seedNodes.add(edge.source);
    seedNodes.add(edge.target);
  }

  // Step 3: Traverse 2 hops from seed nodes for deeper context
  const traversal = graphDB.traverse(Array.from(seedNodes), 2, 15);

  const lines = traversal.edges.map(
    (e) => `- ${e.source} --[${e.relation}]--> ${e.target}`,
  );

  return `\n\nKnowledge Graph Connections:\n${lines.join("\n")}`;
}
