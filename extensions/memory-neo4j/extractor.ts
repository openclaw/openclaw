/**
 * LLM-based entity extraction and sleep cycle for memory-neo4j.
 *
 * Extraction uses a configurable OpenAI-compatible LLM (OpenRouter, Ollama, etc.) to:
 * - Extract entities, relationships, and tags from stored memories
 * - Classify memories into categories (preference, fact, decision, etc.)
 *
 * Runs as background fire-and-forget operations with graceful degradation.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { EntityType, ExtractionResult, MemoryCategory } from "./schema.js";
import { ALLOWED_RELATIONSHIP_TYPES, ENTITY_TYPES, MEMORY_CATEGORIES } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

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
    {"name": "tarun", "type": "person", "aliases": ["boss"], "description": "brief description"}
  ],
  "relationships": [
    {"source": "tarun", "target": "abundent", "type": "WORKS_AT", "confidence": 0.95}
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
// OpenRouter API Client
// ============================================================================

// Timeout for LLM and embedding fetch calls to prevent hanging indefinitely
const FETCH_TIMEOUT_MS = 30_000;

async function callOpenRouter(
  config: ExtractionConfig,
  prompt: string | Array<{ role: string; content: string }>,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

// ============================================================================
// Entity Extraction
// ============================================================================

/** Max retries for transient extraction failures before marking permanently failed */
const MAX_EXTRACTION_RETRIES = 3;

/**
 * Check if an error is transient (network/timeout) vs permanent (JSON parse, etc.)
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("api error 429") ||
    msg.includes("api error 502") ||
    msg.includes("api error 503") ||
    msg.includes("api error 504")
  );
}

/**
 * Extract entities and relationships from a memory text using LLM.
 *
 * Returns { result, transientFailure }:
 * - result is the ExtractionResult or null if extraction returned nothing useful
 * - transientFailure is true if the failure was due to a network/timeout issue
 *   (caller should retry later) vs a permanent failure (bad JSON, etc.)
 */
export async function extractEntities(
  text: string,
  config: ExtractionConfig,
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
    content = await callOpenRouter(config, messages);
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
): Promise<"a" | "b" | "both" | "skip"> {
  if (!config.enabled) return "skip";

  try {
    const content = await callOpenRouter(config, [
      {
        role: "system",
        content: `Two memories may conflict with each other. Determine which should be kept.

If they genuinely contradict each other, keep the one that is more current, specific, or accurate.
If they don't actually conflict (they cover different aspects or are both valid), keep both.

Return JSON: {"keep": "a"|"b"|"both", "reason": "brief explanation"}`,
      },
      { role: "user", content: `Memory A: "${memA}"\nMemory B: "${memB}"` },
    ]);
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
): Promise<void> {
  if (!config.enabled) {
    await db.updateExtractionStatus(memoryId, "skipped").catch(() => {});
    return;
  }

  try {
    const { result, transientFailure } = await extractEntities(text, config);

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
      return;
    }

    // Empty extraction is valid — not all memories have extractable entities
    if (
      result.entities.length === 0 &&
      result.relationships.length === 0 &&
      result.tags.length === 0
    ) {
      await db.updateExtractionStatus(memoryId, "complete");
      return;
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
  }
}

// ============================================================================
// Sleep Cycle - Seven Phase Memory Consolidation
// ============================================================================

/**
 * Sleep Cycle Result - aggregated stats from all phases.
 */
export type SleepCycleResult = {
  // Phase 1: Deduplication
  dedup: {
    clustersFound: number;
    memoriesMerged: number;
  };
  // Phase 1b: Conflict Detection
  conflict: {
    pairsFound: number;
    resolved: number;
    invalidated: number;
  };
  // Phase 1c: Semantic Deduplication
  semanticDedup: {
    pairsChecked: number;
    duplicatesMerged: number;
  };
  // Phase 2: Pareto Scoring & Threshold
  pareto: {
    totalMemories: number;
    coreMemories: number;
    regularMemories: number;
    threshold: number; // The 80th percentile effective score
  };
  // Phase 3: Core Promotion
  promotion: {
    candidatesFound: number;
    promoted: number;
  };
  // Phase 4: Core Demotion
  demotion: {
    candidatesFound: number;
    demoted: number;
  };
  // Phase 6: Decay & Pruning
  decay: {
    memoriesPruned: number;
  };
  // Phase 5: Entity Extraction
  extraction: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  // Phase 7: Orphan Cleanup
  cleanup: {
    entitiesRemoved: number;
    tagsRemoved: number;
  };
  // Overall
  durationMs: number;
  aborted: boolean;
};

export type SleepCycleOptions = {
  // Common
  agentId?: string;
  abortSignal?: AbortSignal;

  // Phase 1: Deduplication
  dedupThreshold?: number; // Vector similarity threshold (default: 0.95)

  // Phase 2-4: Pareto-based Promotion/Demotion
  paretoPercentile?: number; // Top N% for core (default: 0.2 = top 20%)
  promotionMinAgeDays?: number; // Min age before promotion (default: 7)

  // Phase 5: Extraction
  extractionBatchSize?: number; // Memories per batch (default: 50)
  extractionDelayMs?: number; // Delay between batches (default: 1000)

  // Phase 6: Decay
  decayRetentionThreshold?: number; // Below this, memory is pruned (default: 0.1)
  decayBaseHalfLifeDays?: number; // Base half-life in days (default: 30)
  decayImportanceMultiplier?: number; // How much importance extends half-life (default: 2)

  // Progress callback
  onPhaseStart?: (
    phase:
      | "dedup"
      | "conflict"
      | "semanticDedup"
      | "pareto"
      | "promotion"
      | "demotion"
      | "decay"
      | "extraction"
      | "cleanup",
  ) => void;
  onProgress?: (phase: string, message: string) => void;
};

/**
 * Run the full sleep cycle - seven phases of memory consolidation.
 *
 * This implements a Pareto-based memory ecosystem where core memory
 * is bounded to the top 20% of memories by effective score.
 *
 * Phases:
 * 1. DEDUPLICATION - Merge near-duplicate memories (reduce redundancy)
 * 2. PARETO SCORING - Calculate effective scores for all memories
 * 3. CORE PROMOTION - Regular memories above threshold → core
 * 4. CORE DEMOTION - Core memories below threshold → regular
 * 5. DECAY/PRUNING - Remove old, low-importance memories (forgetting curve)
 * 6. EXTRACTION - Form entity relationships (strengthen connections)
 * 7. CLEANUP - Remove orphaned entities/tags (garbage collection)
 *
 * Effective Score Formulas:
 * - Regular memories: importance × freq_boost × recency
 * - Core memories: importance × freq_boost × recency (same for threshold comparison)
 * - Core memory retrieval ranking: freq_boost × recency (pure usage-based)
 *
 * Where:
 * - freq_boost = 1 + log(1 + retrievalCount) × 0.3
 * - recency = 2^(-days_since_last / 14)
 *
 * Benefits:
 * - Self-regulating core memory size (Pareto distribution)
 * - Memories can be promoted AND demoted based on usage
 * - Simulates human memory consolidation during sleep
 *
 * Research basis:
 * - Pareto principle (20/80 rule) for memory tiering
 * - ACT-R memory model for retrieval-based importance
 * - Ebbinghaus forgetting curve for decay
 * - MemGPT/Letta for tiered memory architecture
 */
export async function runSleepCycle(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions = {},
): Promise<SleepCycleResult> {
  const startTime = Date.now();
  const {
    agentId,
    abortSignal,
    dedupThreshold = 0.95,
    paretoPercentile = 0.2,
    promotionMinAgeDays = 7,
    decayRetentionThreshold = 0.1,
    decayBaseHalfLifeDays = 30,
    decayImportanceMultiplier = 2,
    extractionBatchSize = 50,
    extractionDelayMs = 1000,
    onPhaseStart,
    onProgress,
  } = options;

  const result: SleepCycleResult = {
    dedup: { clustersFound: 0, memoriesMerged: 0 },
    conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
    semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
    pareto: { totalMemories: 0, coreMemories: 0, regularMemories: 0, threshold: 0 },
    promotion: { candidatesFound: 0, promoted: 0 },
    demotion: { candidatesFound: 0, demoted: 0 },
    decay: { memoriesPruned: 0 },
    extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
    cleanup: { entitiesRemoved: 0, tagsRemoved: 0 },
    durationMs: 0,
    aborted: false,
  };

  const LLM_CONCURRENCY = 8;

  // --------------------------------------------------------------------------
  // Phase 1: Deduplication (Optimized - combined vector + semantic dedup)
  // Call findDuplicateClusters ONCE at 0.75 threshold, then split by similarity band:
  // - ≥0.95: vector merge (high-confidence duplicates)
  // - 0.75-0.95: semantic dedup via LLM (paraphrases)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("dedup");
    logger.info("memory-neo4j: [sleep] Phase 1: Deduplication (vector + semantic)");

    try {
      // Fetch clusters at 0.75 threshold with similarity scores
      const allClusters = await db.findDuplicateClusters(0.75, agentId, true);

      // Helper to create canonical pair key (sorted)
      const makePairKey = (a: string, b: string): string => {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
      };

      // Separate clusters into high-similarity (≥0.95) and medium-similarity (0.75-0.95)
      const highSimClusters: typeof allClusters = [];
      const mediumSimClusters: typeof allClusters = [];

      for (const cluster of allClusters) {
        if (abortSignal?.aborted) break;
        if (!cluster.similarities || cluster.memoryIds.length < 2) continue;

        // Check if ANY pair in this cluster has similarity ≥ dedupThreshold
        let hasHighSim = false;
        for (const [pairKey, score] of cluster.similarities.entries()) {
          if (score >= dedupThreshold) {
            hasHighSim = true;
            break;
          }
        }

        if (hasHighSim) {
          // Split this cluster into high-sim and medium-sim sub-clusters
          // For simplicity, if a cluster has ANY high-sim pair, treat the whole cluster as high-sim
          // (This matches the old behavior where Phase 1 would merge them all)
          highSimClusters.push(cluster);
        } else {
          mediumSimClusters.push(cluster);
        }
      }

      // Part 1a: Vector merge for high-similarity clusters (≥0.95)
      result.dedup.clustersFound = highSimClusters.length;

      for (const cluster of highSimClusters) {
        if (abortSignal?.aborted) break;

        const { deletedCount } = await db.mergeMemoryCluster(
          cluster.memoryIds,
          cluster.importances,
        );
        result.dedup.memoriesMerged += deletedCount;
        onProgress?.("dedup", `Merged cluster of ${cluster.memoryIds.length} → 1 (vector)`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1a (vector) complete — ${result.dedup.clustersFound} clusters, ${result.dedup.memoriesMerged} merged`,
      );

      // Part 1b: Semantic dedup for medium-similarity clusters (0.75-0.95)
      onPhaseStart?.("semanticDedup");
      logger.info("memory-neo4j: [sleep] Phase 1b: Semantic Deduplication (0.75-0.95 band)");

      // Collect all candidate pairs upfront
      type DedupPair = {
        textA: string;
        textB: string;
        idA: string;
        idB: string;
        importanceA: number;
        importanceB: number;
      };
      const allPairs: DedupPair[] = [];

      for (const cluster of mediumSimClusters) {
        if (cluster.memoryIds.length < 2) continue;
        for (let i = 0; i < cluster.memoryIds.length - 1; i++) {
          for (let j = i + 1; j < cluster.memoryIds.length; j++) {
            allPairs.push({
              textA: cluster.texts[i],
              textB: cluster.texts[j],
              idA: cluster.memoryIds[i],
              idB: cluster.memoryIds[j],
              importanceA: cluster.importances[i],
              importanceB: cluster.importances[j],
            });
          }
        }
      }

      // Process pairs in concurrent batches
      const invalidatedIds = new Set<string>();

      for (let i = 0; i < allPairs.length && !abortSignal?.aborted; i += LLM_CONCURRENCY) {
        const batch = allPairs.slice(i, i + LLM_CONCURRENCY);

        // Filter out pairs where one side was already invalidated
        const activeBatch = batch.filter(
          (p) => !invalidatedIds.has(p.idA) && !invalidatedIds.has(p.idB),
        );

        if (activeBatch.length === 0) continue;

        const outcomes = await Promise.allSettled(
          activeBatch.map((p) => isSemanticDuplicate(p.textA, p.textB, config)),
        );

        for (let k = 0; k < outcomes.length; k++) {
          const pair = activeBatch[k];
          result.semanticDedup.pairsChecked++;

          if (
            outcomes[k].status === "fulfilled" &&
            (outcomes[k] as PromiseFulfilledResult<boolean>).value
          ) {
            // Skip if either side was invalidated by an earlier result in this batch
            if (invalidatedIds.has(pair.idA) || invalidatedIds.has(pair.idB)) continue;

            const keepId = pair.importanceA >= pair.importanceB ? pair.idA : pair.idB;
            const removeId = keepId === pair.idA ? pair.idB : pair.idA;
            const keepText = keepId === pair.idA ? pair.textA : pair.textB;
            const removeText = removeId === pair.idA ? pair.textA : pair.textB;

            await db.invalidateMemory(removeId);
            invalidatedIds.add(removeId);
            result.semanticDedup.duplicatesMerged++;

            onProgress?.(
              "semanticDedup",
              `Merged: "${removeText.slice(0, 50)}..." → kept "${keepText.slice(0, 50)}..."`,
            );
          }
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1b (semantic) complete — ${result.semanticDedup.pairsChecked} pairs checked, ${result.semanticDedup.duplicatesMerged} merged`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 1 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 1c: Conflict Detection (formerly Phase 1b)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("conflict");
    logger.info("memory-neo4j: [sleep] Phase 1c: Conflict Detection");

    try {
      const pairs = await db.findConflictingMemories(agentId);
      result.conflict.pairsFound = pairs.length;

      // Process conflict pairs in parallel chunks of LLM_CONCURRENCY
      for (let i = 0; i < pairs.length && !abortSignal?.aborted; i += LLM_CONCURRENCY) {
        const chunk = pairs.slice(i, i + LLM_CONCURRENCY);
        const outcomes = await Promise.allSettled(
          chunk.map((pair) => resolveConflict(pair.memoryA.text, pair.memoryB.text, config)),
        );

        for (let k = 0; k < outcomes.length; k++) {
          if (abortSignal?.aborted) break;
          const pair = chunk[k];
          const outcome = outcomes[k];
          if (outcome.status !== "fulfilled") continue;

          const decision = outcome.value;
          if (decision === "a") {
            await db.invalidateMemory(pair.memoryB.id);
            result.conflict.invalidated++;
            result.conflict.resolved++;
            onProgress?.(
              "conflict",
              `Kept A, invalidated B: "${pair.memoryB.text.slice(0, 40)}..."`,
            );
          } else if (decision === "b") {
            await db.invalidateMemory(pair.memoryA.id);
            result.conflict.invalidated++;
            result.conflict.resolved++;
            onProgress?.(
              "conflict",
              `Kept B, invalidated A: "${pair.memoryA.text.slice(0, 40)}..."`,
            );
          } else if (decision === "both") {
            result.conflict.resolved++;
            onProgress?.("conflict", `Kept both: no real conflict`);
          }
          // "skip" = LLM unavailable, don't count as resolved
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1c complete — ${result.conflict.pairsFound} pairs, ${result.conflict.resolved} resolved, ${result.conflict.invalidated} invalidated`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 1c error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 2: Pareto Scoring & Threshold Calculation
  // --------------------------------------------------------------------------
  let paretoThreshold = 0;
  let allScores: Awaited<ReturnType<typeof db.calculateAllEffectiveScores>> = [];
  if (!abortSignal?.aborted) {
    onPhaseStart?.("pareto");
    logger.info("memory-neo4j: [sleep] Phase 2: Pareto Scoring");

    try {
      allScores = await db.calculateAllEffectiveScores(agentId);
      result.pareto.totalMemories = allScores.length;
      result.pareto.coreMemories = allScores.filter((s) => s.category === "core").length;
      result.pareto.regularMemories = allScores.filter((s) => s.category !== "core").length;

      // Calculate the threshold for top N% (default: top 20%)
      paretoThreshold = db.calculateParetoThreshold(allScores, 1 - paretoPercentile);
      result.pareto.threshold = paretoThreshold;

      onProgress?.(
        "pareto",
        `Scored ${allScores.length} memories (${result.pareto.coreMemories} core, ${result.pareto.regularMemories} regular)`,
      );
      onProgress?.(
        "pareto",
        `Pareto threshold (top ${paretoPercentile * 100}%): ${paretoThreshold.toFixed(4)}`,
      );

      logger.info(
        `memory-neo4j: [sleep] Phase 2 complete — threshold=${paretoThreshold.toFixed(4)} for top ${paretoPercentile * 100}%`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 2 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 3: Core Promotion (using pre-computed scores from Phase 2)
  //
  // Design note on staleness: The effective scores and Pareto threshold were
  // computed in Phase 2 and may be slightly stale by the time Phases 3/4 run.
  // This is acceptable because: (a) the sleep cycle is a background maintenance
  // task that runs infrequently (not concurrent with itself), (b) the scoring
  // formula is deterministic based on stored properties that change slowly, and
  // (c) promotion/demotion are reversible in the next cycle. The alternative
  // (re-querying scores per phase) adds latency without meaningful accuracy gain.
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && paretoThreshold > 0) {
    onPhaseStart?.("promotion");
    logger.info("memory-neo4j: [sleep] Phase 3: Core Promotion");

    try {
      const candidates = allScores.filter(
        (s) =>
          s.category !== "core" &&
          s.effectiveScore >= paretoThreshold &&
          s.ageDays >= promotionMinAgeDays,
      );
      result.promotion.candidatesFound = candidates.length;

      if (candidates.length > 0) {
        const ids = candidates.map((m) => m.id);
        result.promotion.promoted = await db.promoteToCore(ids);
        for (const c of candidates) {
          onProgress?.(
            "promotion",
            `Promoted "${c.text.slice(0, 40)}..." (score=${c.effectiveScore.toFixed(3)}, ${c.retrievalCount} retrievals)`,
          );
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 3 complete — ${result.promotion.promoted} memories promoted to core`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 3 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 4: Core Demotion (using pre-computed scores from Phase 2)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && paretoThreshold > 0) {
    onPhaseStart?.("demotion");
    logger.info("memory-neo4j: [sleep] Phase 4: Core Demotion");

    try {
      const candidates = allScores.filter(
        (s) => s.category === "core" && s.effectiveScore < paretoThreshold,
      );
      result.demotion.candidatesFound = candidates.length;

      if (candidates.length > 0) {
        const ids = candidates.map((m) => m.id);
        result.demotion.demoted = await db.demoteFromCore(ids);
        for (const c of candidates) {
          onProgress?.(
            "demotion",
            `Demoted "${c.text.slice(0, 40)}..." (score=${c.effectiveScore.toFixed(3)}, ${c.retrievalCount} retrievals)`,
          );
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 4 complete — ${result.demotion.demoted} memories demoted from core`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 4 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 5: Entity Extraction (moved before decay so new memories get
  // extracted before pruning can remove them)
  // --------------------------------------------------------------------------
  // Extraction uses LLM_CONCURRENCY (defined above, matches OLLAMA_NUM_PARALLEL)
  if (!abortSignal?.aborted && config.enabled) {
    onPhaseStart?.("extraction");
    logger.info("memory-neo4j: [sleep] Phase 5: Entity Extraction");

    try {
      // Get initial count
      const counts = await db.countByExtractionStatus(agentId);
      result.extraction.total = counts.pending;

      if (result.extraction.total > 0) {
        let hasMore = true;
        while (hasMore && !abortSignal?.aborted) {
          const pending = await db.listPendingExtractions(extractionBatchSize, agentId);

          if (pending.length === 0) {
            hasMore = false;
            break;
          }

          // Process in parallel chunks of LLM_CONCURRENCY
          for (let i = 0; i < pending.length && !abortSignal?.aborted; i += LLM_CONCURRENCY) {
            const chunk = pending.slice(i, i + LLM_CONCURRENCY);
            const outcomes = await Promise.allSettled(
              chunk.map((memory) =>
                runBackgroundExtraction(
                  memory.id,
                  memory.text,
                  db,
                  embeddings,
                  config,
                  logger,
                  memory.extractionRetries,
                ),
              ),
            );

            for (const outcome of outcomes) {
              result.extraction.processed++;
              if (outcome.status === "fulfilled") {
                result.extraction.succeeded++;
              } else {
                result.extraction.failed++;
              }
            }

            if (result.extraction.processed % 10 === 0 || i + LLM_CONCURRENCY >= pending.length) {
              onProgress?.(
                "extraction",
                `${result.extraction.processed}/${result.extraction.total} processed`,
              );
            }
          }

          // Delay between batches
          if (hasMore && !abortSignal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, extractionDelayMs));
          }
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 5 complete — ${result.extraction.succeeded} extracted, ${result.extraction.failed} failed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 5 error: ${String(err)}`);
    }
  } else if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 5 skipped — extraction not enabled");
  }

  // --------------------------------------------------------------------------
  // Phase 6: Decay & Pruning (after extraction so freshly extracted memories
  // aren't pruned before they build entity connections)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("decay");
    logger.info("memory-neo4j: [sleep] Phase 6: Decay & Pruning");

    try {
      const decayed = await db.findDecayedMemories({
        retentionThreshold: decayRetentionThreshold,
        baseHalfLifeDays: decayBaseHalfLifeDays,
        importanceMultiplier: decayImportanceMultiplier,
        agentId,
      });

      if (decayed.length > 0) {
        const ids = decayed.map((m) => m.id);
        result.decay.memoriesPruned = await db.pruneMemories(ids);
        onProgress?.("decay", `Pruned ${result.decay.memoriesPruned} decayed memories`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 6 complete — ${result.decay.memoriesPruned} memories pruned`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 6 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 7: Orphan Cleanup
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("cleanup");
    logger.info("memory-neo4j: [sleep] Phase 7: Orphan Cleanup");

    try {
      // Clean up orphan entities
      const orphanEntities = await db.findOrphanEntities();
      if (orphanEntities.length > 0) {
        result.cleanup.entitiesRemoved = await db.deleteOrphanEntities(
          orphanEntities.map((e) => e.id),
        );
        onProgress?.("cleanup", `Removed ${result.cleanup.entitiesRemoved} orphan entities`);
      }

      // Clean up orphan tags
      const orphanTags = await db.findOrphanTags();
      if (orphanTags.length > 0) {
        result.cleanup.tagsRemoved = await db.deleteOrphanTags(orphanTags.map((t) => t.id));
        onProgress?.("cleanup", `Removed ${result.cleanup.tagsRemoved} orphan tags`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 7 complete — ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} tags removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 7 error: ${String(err)}`);
    }
  }

  result.durationMs = Date.now() - startTime;
  result.aborted = abortSignal?.aborted ?? false;

  logger.info(
    `memory-neo4j: [sleep] Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s` +
      (result.aborted ? " (aborted)" : ""),
  );

  return result;
}

// ============================================================================
// Message Extraction (re-exported from message-utils.ts)
// ============================================================================

export {
  extractUserMessages,
  extractAssistantMessages,
  stripMessageWrappers,
  stripAssistantWrappers,
} from "./message-utils.js";

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
 * Check whether new text is semantically a duplicate of an existing memory.
 * Uses an LLM to compare meaning rather than surface similarity.
 * Returns true if the new text is a duplicate (should be skipped).
 * Returns false on any failure (allow storage).
 */
export async function isSemanticDuplicate(
  newText: string,
  existingText: string,
  config: ExtractionConfig,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  try {
    const content = await callOpenRouter(config, [
      { role: "system", content: SEMANTIC_DEDUP_SYSTEM },
      { role: "user", content: `Existing memory: "${existingText}"\nNew text: "${newText}"` },
    ]);
    if (!content) {
      return false;
    }

    const parsed = JSON.parse(content) as { verdict?: string };
    return parsed.verdict === "duplicate";
  } catch {
    return false;
  }
}
