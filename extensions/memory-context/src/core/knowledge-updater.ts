/**
 * Knowledge Updater -- applies Mem0-style ADD/UPDATE/SUPERSEDE/NONE logic
 * to merge newly extracted facts into the KnowledgeStore.
 *
 * DELETE is disabled by default (risks LLM hallucination deleting valid facts).
 * Instead, contradictory facts are superseded (soft delete).
 */

import type { ExtractedFact } from "./knowledge-extractor.js";
import { KnowledgeStore, type KnowledgeFact } from "./knowledge-store.js";

export type UpdateAction =
  | { op: "ADD"; fact: ExtractedFact }
  | { op: "UPDATE"; existingId: string; newContent: string; newContext?: string }
  | { op: "SUPERSEDE"; existingId: string; newFact: ExtractedFact }
  | { op: "NONE"; reason: string };

export type UpdateResult = {
  actions: UpdateAction[];
  added: number;
  updated: number;
  superseded: number;
  skipped: number;
};

export type KnowledgeUpdaterOptions = {
  /** Allow hard DELETE (default: false -- use SUPERSEDE instead). */
  allowDelete?: boolean;
};

/**
 * Simple similarity check: normalized Jaccard-like word overlap.
 * Returns 0-1 (1 = identical words).
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      intersection++;
    }
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if most words of A are contained in B (A is a subset/refinement of B).
 * Returns the fraction of A's words found in B. Useful for detecting
 * "old short fact expanded into new detailed fact".
 */
function subsetRatio(shorter: string, longer: string): number {
  const wordsS = new Set(shorter.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsL = new Set(longer.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsS.size === 0) {
    return 0;
  }

  let found = 0;
  for (const w of wordsS) {
    if (wordsL.has(w)) {
      found++;
    }
  }
  return found / wordsS.size;
}

/**
 * Find the best matching existing fact for a new fact.
 * Returns the match and similarity score, or null.
 */
function findBestMatch(
  newFact: ExtractedFact,
  existingFacts: KnowledgeFact[],
): { fact: KnowledgeFact; similarity: number } | null {
  let bestMatch: KnowledgeFact | null = null;
  let bestScore = 0;

  for (const existing of existingFacts) {
    // Must be same type for UPDATE/SUPERSEDE
    if (existing.type !== newFact.type) {
      continue;
    }
    if (existing.supersededBy) {
      continue;
    }

    const sim = wordOverlap(newFact.content, existing.content);
    if (sim > bestScore) {
      bestScore = sim;
      bestMatch = existing;
    }
  }

  // Lower threshold for short facts (short sentences have fewer words to overlap)
  const threshold = 0.2;
  if (bestMatch && bestScore > threshold) {
    return { fact: bestMatch, similarity: bestScore };
  }
  return null;
}

/**
 * Apply extracted facts to the knowledge store.
 *
 * For each new fact:
 * - If exact duplicate exists (content hash match) -> NONE
 * - If similar fact exists (word overlap > 0.3):
 *   - If new fact is longer/more detailed -> UPDATE
 *   - If contradictory (same type, different content) -> SUPERSEDE old + ADD new
 * - Otherwise -> ADD
 */
export async function applyKnowledgeUpdates(
  store: KnowledgeStore,
  newFacts: ExtractedFact[],
  _options?: KnowledgeUpdaterOptions,
): Promise<UpdateResult> {
  // Ensure KnowledgeStore is initialized (loads existing facts from disk).
  await store.init();

  const result: UpdateResult = {
    actions: [],
    added: 0,
    updated: 0,
    superseded: 0,
    skipped: 0,
  };

  const existingFacts = store.getActive();

  for (const newFact of newFacts) {
    // Check exact duplicate
    const exactMatch = store.findByContent(newFact.content);
    if (exactMatch && !exactMatch.supersededBy) {
      result.actions.push({ op: "NONE", reason: "exact duplicate" });
      result.skipped++;
      continue;
    }

    // Check similar existing fact
    const match = findBestMatch(newFact, existingFacts);

    if (match) {
      // Check if the old fact's words are mostly contained in the new fact
      // (indicates the new fact is a more detailed version of the old one)
      const isRefinement =
        newFact.content.length > match.fact.content.length * 1.2 &&
        subsetRatio(match.fact.content, newFact.content) > 0.5;

      if (match.similarity > 0.5 || isRefinement) {
        // Similar or refinement -- check if new is more detailed
        if (newFact.content.length > match.fact.content.length * 1.2) {
          // New fact is more detailed -> UPDATE
          await store.update(match.fact.id, newFact.content, newFact.context);
          result.actions.push({
            op: "UPDATE",
            existingId: match.fact.id,
            newContent: newFact.content,
            newContext: newFact.context,
          });
          result.updated++;
        } else {
          // Similar enough to skip
          result.actions.push({ op: "NONE", reason: "similar existing fact" });
          result.skipped++;
        }
      } else {
        // Moderately similar but different -> SUPERSEDE old + ADD new
        const added = await store.add(newFact);
        await store.supersede(match.fact.id, added.id);
        result.actions.push({
          op: "SUPERSEDE",
          existingId: match.fact.id,
          newFact,
        });
        result.superseded++;
      }
    } else {
      // No match -> ADD
      await store.add(newFact);
      result.actions.push({ op: "ADD", fact: newFact });
      result.added++;
    }
  }

  return result;
}

// Export for testing
export const __testing = { wordOverlap, subsetRatio, findBestMatch };
