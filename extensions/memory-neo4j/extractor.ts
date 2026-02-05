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

const ENTITY_EXTRACTION_PROMPT = `You are an entity extraction system for a personal memory store.
Extract entities and relationships from this memory text, and classify the memory.

Memory: "{text}"

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

async function callOpenRouter(config: ExtractionConfig, prompt: string): Promise<string | null> {
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
          messages: [{ role: "user", content: prompt }],
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

  const prompt = ENTITY_EXTRACTION_PROMPT.replace("{text}", text);

  let content: string | null;
  try {
    content = await callOpenRouter(config, prompt);
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

    // Generate embeddings for entity names (for entity vector search)
    let entityEmbeddings: Map<string, number[]> | undefined;
    if (result.entities.length > 0) {
      try {
        const names = result.entities.map((e) => e.name);
        const vectors = await embeddings.embedBatch(names);
        entityEmbeddings = new Map(names.map((n, i) => [n, vectors[i]]));
      } catch (err) {
        logger.debug?.(`memory-neo4j: entity embedding generation failed: ${String(err)}`);
      }
    }

    // MERGE Entity nodes
    for (const entity of result.entities) {
      try {
        await db.mergeEntity({
          id: randomUUID(),
          name: entity.name,
          type: entity.type,
          aliases: entity.aliases,
          description: entity.description,
          embedding: entityEmbeddings?.get(entity.name),
        });

        // Create MENTIONS relationship
        await db.createMentions(memoryId, entity.name, "context", 1.0);
      } catch (err) {
        logger.warn(`memory-neo4j: entity merge failed for "${entity.name}": ${String(err)}`);
      }
    }

    // Create inter-Entity relationships
    for (const rel of result.relationships) {
      try {
        await db.createEntityRelationship(rel.source, rel.target, rel.type, rel.confidence);
      } catch (err) {
        logger.debug?.(
          `memory-neo4j: relationship creation failed: ${rel.source}->${rel.target}: ${String(err)}`,
        );
      }
    }

    // Tag the memory
    for (const tag of result.tags) {
      try {
        await db.tagMemory(memoryId, tag.name, tag.category);
      } catch (err) {
        logger.debug?.(`memory-neo4j: tagging failed for "${tag.name}": ${String(err)}`);
      }
    }

    // Update category if the LLM classified it (only overwrites 'other')
    if (result.category) {
      await db.updateMemoryCategory(memoryId, result.category);
    }

    await db.updateExtractionStatus(memoryId, "complete");
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
// Sleep Cycle - Five Phase Memory Consolidation
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
  // Phase 5: Decay & Pruning
  decay: {
    memoriesPruned: number;
  };
  // Phase 6: Entity Extraction
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

  // Phase 5: Decay
  decayRetentionThreshold?: number; // Below this, memory is pruned (default: 0.1)
  decayBaseHalfLifeDays?: number; // Base half-life in days (default: 30)
  decayImportanceMultiplier?: number; // How much importance extends half-life (default: 2)

  // Phase 6: Extraction
  extractionBatchSize?: number; // Memories per batch (default: 50)
  extractionDelayMs?: number; // Delay between batches (default: 1000)

  // Progress callback
  onPhaseStart?: (
    phase: "dedup" | "pareto" | "promotion" | "demotion" | "decay" | "extraction" | "cleanup",
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
    pareto: { totalMemories: 0, coreMemories: 0, regularMemories: 0, threshold: 0 },
    promotion: { candidatesFound: 0, promoted: 0 },
    demotion: { candidatesFound: 0, demoted: 0 },
    decay: { memoriesPruned: 0 },
    extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
    cleanup: { entitiesRemoved: 0, tagsRemoved: 0 },
    durationMs: 0,
    aborted: false,
  };

  // --------------------------------------------------------------------------
  // Phase 1: Deduplication
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("dedup");
    logger.info("memory-neo4j: [sleep] Phase 1: Deduplication");

    try {
      const clusters = await db.findDuplicateClusters(dedupThreshold, agentId);
      result.dedup.clustersFound = clusters.length;

      for (const cluster of clusters) {
        if (abortSignal?.aborted) {
          break;
        }

        const { deletedCount } = await db.mergeMemoryCluster(
          cluster.memoryIds,
          cluster.importances,
        );
        result.dedup.memoriesMerged += deletedCount;
        onProgress?.("dedup", `Merged cluster of ${cluster.memoryIds.length} → 1`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1 complete — ${result.dedup.clustersFound} clusters, ${result.dedup.memoriesMerged} merged`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 1 error: ${String(err)}`);
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
  const EXTRACTION_CONCURRENCY = 3;
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

          // Process in parallel chunks of EXTRACTION_CONCURRENCY
          for (
            let i = 0;
            i < pending.length && !abortSignal?.aborted;
            i += EXTRACTION_CONCURRENCY
          ) {
            const chunk = pending.slice(i, i + EXTRACTION_CONCURRENCY);
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

            if (
              result.extraction.processed % 10 === 0 ||
              i + EXTRACTION_CONCURRENCY >= pending.length
            ) {
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
// Message Extraction Helper
// ============================================================================

/**
 * Extract user message texts from the event.messages array.
 * Handles both string content and content block arrays.
 */
export function extractUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;

    // Only process user messages for auto-capture
    if (msgObj.role !== "user") {
      continue;
    }

    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  // Filter out noise
  return texts.filter(
    (t) => t.length >= 10 && !t.includes("<relevant-memories>") && !t.includes("<system>"),
  );
}
