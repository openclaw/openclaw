/**
 * LLM-based entity extraction and memory operations for memory-neo4j.
 *
 * Extraction uses a configurable OpenAI-compatible LLM (OpenRouter, Ollama, etc.) to:
 * - Extract entities, relationships, and tags from stored memories
 * - Classify memories into categories (preference, fact, decision, etc.)
 * - Rate memory importance on a 1-10 scale
 * - Detect semantic duplicates via LLM comparison
 * - Resolve conflicting memories
 *
 * Runs as background fire-and-forget operations with graceful degradation.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { EntityType, ExtractionResult, Logger, MemoryCategory } from "./schema.js";
import { callOpenRouter, callOpenRouterStream, isTransientError } from "./llm-client.js";
import { ALLOWED_RELATIONSHIP_TYPES, ENTITY_TYPES, MEMORY_CATEGORIES } from "./schema.js";

// ============================================================================
// Extraction Prompt
// ============================================================================

// System instruction (no user data) — user message contains the memory text
const ENTITY_EXTRACTION_SYSTEM = `You are an entity extraction system for a personal memory store.
Extract entities and relationships from the memory text provided by the user, and classify the memory.

Return JSON:
{
  "category": "preference|fact|decision|entity|other",
  "entities": [
    {"name": "alice", "type": "person", "aliases": ["manager"], "description": "brief description"}
  ],
  "relationships": [
    {"source": "alice", "target": "acme corp", "type": "WORKS_AT", "confidence": 0.95}
  ],
  "tags": [
    {"name": "neo4j", "category": "technology"}
  ]
}

Rules:
- Normalize entity names to lowercase
- Entity types: person, organization, location, event, concept
- Relationship types: WORKS_AT, LIVES_AT, KNOWS, MARRIED_TO, PREFERS, DECIDED, RELATED_TO
- Confidence: 0.0-1.0
- Only extract what's explicitly stated or strongly implied
- Return empty arrays if nothing to extract
- Keep entity descriptions brief (1 sentence max)
- Category: "preference" for opinions/preferences, "fact" for factual info, "decision" for choices made, "entity" for entity-focused, "other" for miscellaneous`;

// ============================================================================
// Entity Extraction
// ============================================================================

/**
 * Max retries for transient extraction failures before marking permanently failed.
 *
 * Retry budget accounting — two layers of retry:
 *   Layer 1: callOpenRouter/callOpenRouterStream internal retries (config.maxRetries, default 2 = 3 attempts)
 *   Layer 2: Sleep cycle retries (MAX_EXTRACTION_RETRIES = 3 sleep cycles)
 *   Total worst-case: 3 × 3 = 9 LLM attempts per memory
 */
const MAX_EXTRACTION_RETRIES = 3;

/**
 * Extract entities and relationships from a memory text using LLM.
 *
 * Uses streaming for responsive abort signal handling and better latency.
 *
 * Returns { result, transientFailure }:
 * - result is the ExtractionResult or null if extraction returned nothing useful
 * - transientFailure is true if the failure was due to a network/timeout issue
 *   (caller should retry later) vs a permanent failure (bad JSON, etc.)
 */
export async function extractEntities(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<{ result: ExtractionResult | null; transientFailure: boolean }> {
  if (!config.enabled) {
    return { result: null, transientFailure: false };
  }

  // System/user separation prevents memory text from being interpreted as instructions
  const messages = [
    { role: "system", content: ENTITY_EXTRACTION_SYSTEM },
    { role: "user", content: text },
  ];

  let content: string | null;
  try {
    // Use streaming for extraction — allows responsive abort and better latency
    content = await callOpenRouterStream(config, messages, abortSignal);
  } catch (err) {
    // Network/timeout errors are transient — caller should retry
    return { result: null, transientFailure: isTransientError(err) };
  }

  if (!content) {
    return { result: null, transientFailure: false };
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return { result: validateExtractionResult(parsed), transientFailure: false };
  } catch {
    // JSON parse failure is permanent — LLM returned malformed output
    return { result: null, transientFailure: false };
  }
}

/**
 * Validate and sanitize LLM extraction output.
 */
function validateExtractionResult(raw: Record<string, unknown>): ExtractionResult {
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  const validEntityTypes = new Set<string>(ENTITY_TYPES);
  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const rawCategory = typeof raw.category === "string" ? raw.category : undefined;
  const category =
    rawCategory && validCategories.has(rawCategory) ? (rawCategory as MemoryCategory) : undefined;

  return {
    category,
    entities: entities
      .filter(
        (e: unknown): e is Record<string, unknown> =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).type === "string",
      )
      .map((e) => ({
        name: String(e.name).trim().toLowerCase(),
        type: validEntityTypes.has(String(e.type)) ? (String(e.type) as EntityType) : "concept",
        aliases: Array.isArray(e.aliases)
          ? (e.aliases as unknown[])
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toLowerCase())
          : undefined,
        description: typeof e.description === "string" ? e.description : undefined,
      }))
      .filter((e) => e.name.length > 0),

    relationships: relationships
      .filter(
        (r: unknown): r is Record<string, unknown> =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as Record<string, unknown>).source === "string" &&
          typeof (r as Record<string, unknown>).target === "string" &&
          typeof (r as Record<string, unknown>).type === "string" &&
          ALLOWED_RELATIONSHIP_TYPES.has(String((r as Record<string, unknown>).type)),
      )
      .map((r) => ({
        source: String(r.source).trim().toLowerCase(),
        target: String(r.target).trim().toLowerCase(),
        type: String(r.type),
        confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
      })),

    tags: tags
      .filter(
        (t: unknown): t is Record<string, unknown> =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).name === "string",
      )
      .map((t) => ({
        name: String(t.name).trim().toLowerCase(),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0),
  };
}

// ============================================================================
// Conflict Resolution
// ============================================================================

/**
 * Use an LLM to determine whether two memories genuinely conflict.
 * Returns which memory to keep, or "both" if they don't actually conflict.
 * Returns "skip" on any failure (network, parse, disabled config).
 */
export async function resolveConflict(
  memA: string,
  memB: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"a" | "b" | "both" | "skip"> {
  if (!config.enabled) return "skip";

  try {
    const content = await callOpenRouter(
      config,
      [
        {
          role: "system",
          content: `Two memories may conflict with each other. Determine which should be kept.

If they genuinely contradict each other, keep the one that is more current, specific, or accurate.
If they don't actually conflict (they cover different aspects or are both valid), keep both.

Return JSON: {"keep": "a"|"b"|"both", "reason": "brief explanation"}`,
        },
        { role: "user", content: `Memory A: "${memA}"\nMemory B: "${memB}"` },
      ],
      abortSignal,
    );
    if (!content) return "skip";

    const parsed = JSON.parse(content) as { keep?: string };
    const keep = parsed.keep;
    if (keep === "a" || keep === "b" || keep === "both") return keep;
    return "skip";
  } catch {
    return "skip";
  }
}

// ============================================================================
// Background Extraction Pipeline
// ============================================================================

/**
 * Run entity extraction in the background for a stored memory.
 * Fire-and-forget: errors are logged but never propagated.
 *
 * Flow:
 * 1. Call LLM to extract entities and relationships
 * 2. MERGE Entity nodes (idempotent)
 * 3. Create MENTIONS relationships from Memory → Entity
 * 4. Create inter-Entity relationships (WORKS_AT, KNOWS, etc.)
 * 5. Tag the memory
 * 6. Update extractionStatus to "complete", "pending" (transient retry), or "failed"
 *
 * Transient failures (network/timeout) leave status as "pending" with an incremented
 * retry counter. After MAX_EXTRACTION_RETRIES transient failures, the memory is
 * permanently marked "failed". Permanent failures (malformed JSON) are immediately "failed".
 */
export async function runBackgroundExtraction(
  memoryId: string,
  text: string,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  currentRetries: number = 0,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; memoryId: string }> {
  if (!config.enabled) {
    await db.updateExtractionStatus(memoryId, "skipped").catch(() => {});
    return { success: true, memoryId };
  }

  try {
    const { result, transientFailure } = await extractEntities(text, config, abortSignal);

    if (!result) {
      if (transientFailure) {
        // Transient failure (network/timeout) — leave as pending for retry
        const retries = currentRetries + 1;
        if (retries >= MAX_EXTRACTION_RETRIES) {
          logger.warn(
            `memory-neo4j: extraction permanently failed for ${memoryId.slice(0, 8)} after ${retries} transient retries`,
          );
          await db.updateExtractionStatus(memoryId, "failed", { incrementRetries: true });
        } else {
          logger.info(
            `memory-neo4j: extraction transient failure for ${memoryId.slice(0, 8)}, will retry (${retries}/${MAX_EXTRACTION_RETRIES})`,
          );
          // Keep status as "pending" but increment retry counter
          await db.updateExtractionStatus(memoryId, "pending", { incrementRetries: true });
        }
      } else {
        // Permanent failure (JSON parse, empty response, etc.)
        await db.updateExtractionStatus(memoryId, "failed");
      }
      return { success: false, memoryId };
    }

    // Empty extraction is valid — not all memories have extractable entities
    if (
      result.entities.length === 0 &&
      result.relationships.length === 0 &&
      result.tags.length === 0
    ) {
      await db.updateExtractionStatus(memoryId, "complete");
      return { success: true, memoryId };
    }

    // Batch all entity operations into a single transaction:
    // entity merges, mentions, relationships, tags, category, and extraction status
    await db.batchEntityOperations(
      memoryId,
      result.entities.map((e) => ({
        id: randomUUID(),
        name: e.name,
        type: e.type,
        aliases: e.aliases,
        description: e.description,
      })),
      result.relationships,
      result.tags,
      result.category,
    );

    logger.info(
      `memory-neo4j: extraction complete for ${memoryId.slice(0, 8)} — ` +
        `${result.entities.length} entities, ${result.relationships.length} rels, ${result.tags.length} tags` +
        (result.category ? `, category=${result.category}` : ""),
    );
    return { success: true, memoryId };
  } catch (err) {
    // Unexpected error during graph operations — treat as transient if retry budget remains
    const isTransient = isTransientError(err);
    if (isTransient && currentRetries + 1 < MAX_EXTRACTION_RETRIES) {
      logger.warn(
        `memory-neo4j: extraction transient error for ${memoryId.slice(0, 8)}, will retry: ${String(err)}`,
      );
      await db
        .updateExtractionStatus(memoryId, "pending", { incrementRetries: true })
        .catch(() => {});
    } else {
      logger.warn(`memory-neo4j: extraction failed for ${memoryId.slice(0, 8)}: ${String(err)}`);
      await db
        .updateExtractionStatus(memoryId, "failed", { incrementRetries: true })
        .catch(() => {});
    }
    return { success: false, memoryId };
  }
}

// ============================================================================
// LLM-Judged Importance Rating
// ============================================================================

// System instruction — user message contains the text to rate
const IMPORTANCE_RATING_SYSTEM = `Rate the long-term importance of remembering the user's information on a scale of 1-10.
1-3: Trivial/transient (greetings, temporary status)
4-6: Moderately useful (general facts, minor preferences)
7-9: Very important (key decisions, strong preferences, critical facts)
10: Essential (identity-defining, safety-critical)

Return JSON: {"score": N, "reason": "brief explanation"}`;

/**
 * Rate the long-term importance of a text using an LLM.
 * Returns a value between 0.1 and 1.0, or 0.5 on any failure.
 */
export async function rateImportance(text: string, config: ExtractionConfig): Promise<number> {
  if (!config.enabled) {
    return 0.5;
  }

  try {
    const content = await callOpenRouter(config, [
      { role: "system", content: IMPORTANCE_RATING_SYSTEM },
      { role: "user", content: text },
    ]);
    if (!content) {
      return 0.5;
    }

    const parsed = JSON.parse(content) as { score?: unknown };
    const score = typeof parsed.score === "number" ? parsed.score : NaN;
    if (Number.isNaN(score)) {
      return 0.5;
    }

    const clamped = Math.max(1, Math.min(10, score));
    return Math.max(0.1, Math.min(1.0, clamped / 10));
  } catch {
    return 0.5;
  }
}

// ============================================================================
// Semantic Deduplication
// ============================================================================

// System instruction — user message contains the two texts to compare
const SEMANTIC_DEDUP_SYSTEM = `You are a memory deduplication system. Determine whether the new text conveys the SAME factual information as the existing memory.

Rules:
- Return "duplicate" if the new text is conveying the same core fact(s), even if worded differently
- Return "duplicate" if the new text is a subset of information already in the existing memory
- Return "unique" if the new text contains genuinely new information not in the existing memory
- Ignore differences in formatting, pronouns, or phrasing — focus on the underlying facts

Return JSON: {"verdict": "duplicate"|"unique", "reason": "brief explanation"}`;

/**
 * Minimum cosine similarity to proceed with the LLM comparison.
 * Below this threshold, texts are too dissimilar to be semantic duplicates,
 * saving an expensive LLM call. Exported for testing.
 */
export const SEMANTIC_DEDUP_VECTOR_THRESHOLD = 0.8;

/**
 * Check whether new text is semantically a duplicate of an existing memory.
 *
 * When a pre-computed vector similarity score is provided (from findSimilar
 * or findDuplicateClusters), the LLM call is skipped entirely for pairs
 * below SEMANTIC_DEDUP_VECTOR_THRESHOLD — a fast pre-screen that avoids
 * the most expensive part of the pipeline.
 *
 * Returns true if the new text is a duplicate (should be skipped).
 * Returns false on any failure (allow storage).
 */
export async function isSemanticDuplicate(
  newText: string,
  existingText: string,
  config: ExtractionConfig,
  vectorSimilarity?: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  // Vector pre-screen: skip LLM call when similarity is below threshold
  if (vectorSimilarity !== undefined && vectorSimilarity < SEMANTIC_DEDUP_VECTOR_THRESHOLD) {
    return false;
  }

  try {
    const content = await callOpenRouter(
      config,
      [
        { role: "system", content: SEMANTIC_DEDUP_SYSTEM },
        { role: "user", content: `Existing memory: "${existingText}"\nNew text: "${newText}"` },
      ],
      abortSignal,
    );
    if (!content) {
      return false;
    }

    const parsed = JSON.parse(content) as { verdict?: string };
    return parsed.verdict === "duplicate";
  } catch {
    return false;
  }
}
