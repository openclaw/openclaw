/**
 * Memory Consolidation Module ("Sleep Mode")
 *
 * Periodically merges similar memories into stronger, more concise facts.
 * Like human memory consolidation during sleep.
 *
 * How it works:
 * 1. Scan all memories in the database
 * 2. Group by semantic similarity (using embeddings)
 * 3. For each cluster (≥2 items), ask LLM to merge into one fact
 * 4. Replace originals with the merged version
 *
 * This keeps the memory store clean, fast, and token-efficient.
 */

import type { ChatModel } from "./chat.js";
import type { Embeddings } from "./embeddings.js";

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationResult {
  clustersFound: number;
  memoriesMerged: number;
  memoriesCreated: number;
  details: Array<{
    merged: string[];
    into: string;
  }>;
}

// ============================================================================
// Clustering (Simple Greedy)
// ============================================================================

/**
 * Group memory texts by semantic similarity.
 * Uses a greedy approach: for each memory, find all others within
 * the similarity threshold and form a cluster.
 *
 * NOTE: This uses cosine similarity (range -1 to 1), which is different from
 * the L2-based similarity used in MemoryDB.search() (sim = 1/(1+d)).
 * A threshold of 0.85 here is NOT equivalent to 0.85 in search.
 * Cosine similarity is the standard for clustering in ML.
 *
 * Time complexity: O(n²) — fine for <1000 memories.
 */
export function clusterBySimilarity(
  items: Array<{ id: string; text: string; vector: number[] }>,
  similarityThreshold = 0.85,
): Array<Array<{ id: string; text: string }>> {
  if (items.length < 2) return [];

  const used = new Set<string>();
  const clusters: Array<Array<{ id: string; text: string }>> = [];

  for (let i = 0; i < items.length; i++) {
    if (used.has(items[i].id)) continue;

    const cluster: Array<{ id: string; text: string }> = [{ id: items[i].id, text: items[i].text }];
    used.add(items[i].id);

    for (let j = i + 1; j < items.length; j++) {
      if (used.has(items[j].id)) continue;

      const sim = cosineSimilarity(items[i].vector, items[j].vector);
      if (sim >= similarityThreshold) {
        cluster.push({ id: items[j].id, text: items[j].text });
        used.add(items[j].id);
      }
    }

    // Only keep clusters with 2+ items
    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

/**
 * Cosine similarity between two vectors.
 * Returns value between -1 and 1 (1 = identical).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// ============================================================================
// LLM Merge
// ============================================================================

/**
 * Ask LLM to merge multiple related facts into one concise statement.
 * Example:
 *   Input: ["User likes coffee", "User drinks coffee every morning", "User prefers black coffee"]
 *   Output: "User drinks black coffee every morning (strong preference)"
 */
export async function mergeFacts(facts: string[], chatModel: ChatModel): Promise<string | null> {
  if (facts.length < 2) return null;

  const numberedFacts = facts
    .map((f, i) => `${i + 1}. "${JSON.stringify(f).slice(1, -1)}"`)
    .join("\n");

  const prompt = `These facts are about the same topic. Merge them into ONE concise, complete statement.
Keep ALL important details. Do NOT lose any information.

Facts:
${numberedFacts}

Return ONLY the merged fact as a single plain text string (no JSON, no quotes, no explanation).`;

  try {
    const response = await chatModel.complete(
      [{ role: "user", content: prompt }],
      false, // plain text, not JSON
    );

    const merged = response.trim();

    // Sanity checks
    if (merged.length < 5 || merged.length > 500) return null;

    return merged;
  } catch {
    return null;
  }
}

// ============================================================================
// Export cosine similarity for testing
// ============================================================================

export { cosineSimilarity };
