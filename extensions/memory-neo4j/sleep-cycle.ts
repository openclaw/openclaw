/**
 * Seven-phase sleep cycle for memory consolidation.
 *
 * Implements a Pareto-based memory ecosystem where core memory
 * is bounded to the top 20% of memories by effective score.
 *
 * Phases:
 * 1. DEDUPLICATION - Merge near-duplicate memories (reduce redundancy)
 * 2. PARETO SCORING - Calculate effective scores for all memories
 * 3. CORE PROMOTION - Regular memories above threshold -> core
 * 4. CORE DEMOTION - Core memories below threshold -> regular
 * 5. DECAY/PRUNING - Remove old, low-importance memories (forgetting curve)
 * 6. EXTRACTION - Form entity relationships (strengthen connections)
 * 7. CLEANUP - Remove orphaned entities/tags (garbage collection)
 *
 * Research basis:
 * - Pareto principle (20/80 rule) for memory tiering
 * - ACT-R memory model for retrieval-based importance
 * - Ebbinghaus forgetting curve for decay
 * - MemGPT/Letta for tiered memory architecture
 */

import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { isSemanticDuplicate, resolveConflict, runBackgroundExtraction } from "./extractor.js";
import { makePairKey } from "./schema.js";

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
  // Phase 4: Entity Extraction
  extraction: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  // Phase 4: Decay & Pruning
  decay: {
    memoriesPruned: number;
  };
  // Phase 5: Orphan Cleanup
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
  skipSemanticDedup?: boolean; // Skip LLM-based semantic dedup (Phase 1b) and conflict detection (Phase 1c)

  // Phase 2-3: Pareto-based Promotion
  paretoPercentile?: number; // Top N% for core (default: 0.2 = top 20%)
  promotionMinAgeDays?: number; // Min age before promotion (default: 7)

  // Phase 1b: Semantic Dedup
  maxSemanticDedupPairs?: number; // Max LLM-checked pairs (default: 500)

  // Concurrency
  llmConcurrency?: number; // Parallel LLM calls (default: 8, match OLLAMA_NUM_PARALLEL)

  // Phase 4: Extraction
  extractionBatchSize?: number; // Memories per batch (default: 50)
  extractionDelayMs?: number; // Delay between batches (default: 1000)

  // Phase 4: Decay
  decayRetentionThreshold?: number; // Below this, memory is pruned (default: 0.1)
  decayBaseHalfLifeDays?: number; // Base half-life in days (default: 30)
  decayImportanceMultiplier?: number; // How much importance extends half-life (default: 2)
  decayCurves?: Record<string, { halfLifeDays: number }>; // Per-category decay curve overrides

  // Progress callback
  onPhaseStart?: (
    phase:
      | "dedup"
      | "conflict"
      | "semanticDedup"
      | "pareto"
      | "promotion"
      | "decay"
      | "extraction"
      | "cleanup",
  ) => void;
  onProgress?: (phase: string, message: string) => void;
};

// ============================================================================
// Sleep Cycle Implementation
// ============================================================================

/**
 * Run the full sleep cycle - seven phases of memory consolidation.
 *
 * This implements a Pareto-based memory ecosystem where core memory
 * is bounded to the top 20% of memories by effective score.
 *
 * Effective Score Formulas:
 * - Regular memories: importance x freq_boost x recency
 * - Core memories: importance x freq_boost x recency (same for threshold comparison)
 * - Core memory retrieval ranking: freq_boost x recency (pure usage-based)
 *
 * Where:
 * - freq_boost = 1 + log(1 + retrievalCount) x 0.3
 * - recency = 2^(-days_since_last / 14)
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
    skipSemanticDedup = false,
    maxSemanticDedupPairs = 500,
    llmConcurrency = 8,
    paretoPercentile = 0.2,
    promotionMinAgeDays = 7,
    decayRetentionThreshold = 0.1,
    decayBaseHalfLifeDays = 30,
    decayImportanceMultiplier = 2,
    decayCurves,
    extractionBatchSize = 50,
    extractionDelayMs = 1000,
    onPhaseStart,
    onProgress,
  } = options;

  const result: SleepCycleResult = {
    dedup: { clustersFound: 0, memoriesMerged: 0 },
    conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
    semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
    pareto: {
      totalMemories: 0,
      coreMemories: 0,
      regularMemories: 0,
      threshold: 0,
    },
    promotion: { candidatesFound: 0, promoted: 0 },
    decay: { memoriesPruned: 0 },
    extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
    cleanup: { entitiesRemoved: 0, tagsRemoved: 0 },
    durationMs: 0,
    aborted: false,
  };

  // --------------------------------------------------------------------------
  // Phase 1: Deduplication (Optimized - combined vector + semantic dedup)
  // Call findDuplicateClusters ONCE at 0.75 threshold, then split by similarity band:
  // - >=0.95: vector merge (high-confidence duplicates)
  // - 0.75-0.95: semantic dedup via LLM (paraphrases)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("dedup");
    logger.info("memory-neo4j: [sleep] Phase 1: Deduplication (vector + semantic)");

    try {
      // Fetch clusters at 0.75 threshold with similarity scores
      const allClusters = await db.findDuplicateClusters(0.75, agentId, true);

      // Separate clusters into high-similarity (>=0.95) and medium-similarity (0.75-0.95)
      const highSimClusters: typeof allClusters = [];
      const mediumSimClusters: typeof allClusters = [];

      for (const cluster of allClusters) {
        if (abortSignal?.aborted) break;
        if (!cluster.similarities || cluster.memoryIds.length < 2) continue;

        // Check if ANY pair in this cluster has similarity >= dedupThreshold
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

      // Part 1a: Vector merge for high-similarity clusters (>=0.95)
      result.dedup.clustersFound = highSimClusters.length;

      for (const cluster of highSimClusters) {
        if (abortSignal?.aborted) break;

        const { deletedCount } = await db.mergeMemoryCluster(
          cluster.memoryIds,
          cluster.importances,
        );
        result.dedup.memoriesMerged += deletedCount;
        onProgress?.("dedup", `Merged cluster of ${cluster.memoryIds.length} -> 1 (vector)`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1a (vector) complete — ${result.dedup.clustersFound} clusters, ${result.dedup.memoriesMerged} merged`,
      );

      // Part 1b: Semantic dedup for medium-similarity clusters (0.75-0.95)
      if (skipSemanticDedup) {
        onPhaseStart?.("semanticDedup");
        logger.info("memory-neo4j: [sleep] Phase 1b: Skipped (--skip-semantic)");
        onProgress?.("semanticDedup", "Skipped — semantic dedup disabled");
      } else {
        onPhaseStart?.("semanticDedup");
        logger.info("memory-neo4j: [sleep] Phase 1b: Semantic Deduplication (0.75-0.95 band)");

        // Collect all candidate pairs upfront (with pairwise similarity for pre-screening)
        type DedupPair = {
          textA: string;
          textB: string;
          idA: string;
          idB: string;
          importanceA: number;
          importanceB: number;
          similarity?: number;
        };
        const allPairs: DedupPair[] = [];

        for (const cluster of mediumSimClusters) {
          if (cluster.memoryIds.length < 2) continue;
          for (let i = 0; i < cluster.memoryIds.length - 1; i++) {
            for (let j = i + 1; j < cluster.memoryIds.length; j++) {
              const pairKey = makePairKey(cluster.memoryIds[i], cluster.memoryIds[j]);
              allPairs.push({
                textA: cluster.texts[i],
                textB: cluster.texts[j],
                idA: cluster.memoryIds[i],
                idB: cluster.memoryIds[j],
                importanceA: cluster.importances[i],
                importanceB: cluster.importances[j],
                similarity: cluster.similarities?.get(pairKey),
              });
            }
          }
        }

        // Cap the number of LLM-checked pairs to prevent sleep cycle timeouts.
        // Sort by similarity descending so higher-similarity pairs (more likely
        // to be duplicates) are checked first.
        if (allPairs.length > maxSemanticDedupPairs) {
          allPairs.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
          const skipped = allPairs.length - maxSemanticDedupPairs;
          allPairs.length = maxSemanticDedupPairs;
          onProgress?.(
            "semanticDedup",
            `Capped at ${maxSemanticDedupPairs} pairs (${skipped} lower-similarity pairs skipped)`,
          );
          logger.info(
            `memory-neo4j: [sleep] Phase 1b capped to ${maxSemanticDedupPairs} pairs (${skipped} skipped)`,
          );
        }

        // Process pairs in concurrent batches
        const invalidatedIds = new Set<string>();

        for (let i = 0; i < allPairs.length && !abortSignal?.aborted; i += llmConcurrency) {
          const batch = allPairs.slice(i, i + llmConcurrency);

          // Filter out pairs where one side was already invalidated
          const activeBatch = batch.filter(
            (p) => !invalidatedIds.has(p.idA) && !invalidatedIds.has(p.idB),
          );

          if (activeBatch.length === 0) continue;

          const outcomes = await Promise.allSettled(
            activeBatch.map((p) =>
              isSemanticDuplicate(p.textA, p.textB, config, p.similarity, abortSignal),
            ),
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
                `Merged: "${removeText.slice(0, 50)}..." -> kept "${keepText.slice(0, 50)}..."`,
              );
            }
          }
        }

        logger.info(
          `memory-neo4j: [sleep] Phase 1b (semantic) complete — ${result.semanticDedup.pairsChecked} pairs checked, ${result.semanticDedup.duplicatesMerged} merged`,
        );
      } // close skipSemanticDedup else
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 1 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 1c: Conflict Detection (formerly Phase 1b)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && !skipSemanticDedup) {
    onPhaseStart?.("conflict");
    logger.info("memory-neo4j: [sleep] Phase 1c: Conflict Detection");

    try {
      const pairs = await db.findConflictingMemories(agentId);
      result.conflict.pairsFound = pairs.length;

      // Process conflict pairs in parallel chunks of llmConcurrency
      for (let i = 0; i < pairs.length && !abortSignal?.aborted; i += llmConcurrency) {
        const chunk = pairs.slice(i, i + llmConcurrency);
        const outcomes = await Promise.allSettled(
          chunk.map((pair) =>
            resolveConflict(pair.memoryA.text, pair.memoryB.text, config, abortSignal),
          ),
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
  // (c) promotion is a one-way operation (core memories are never auto-demoted;
  // bad core memories are handled manually via memory_forget). The alternative
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
  // Phase 4: Entity Extraction (moved before decay so new memories get
  // extracted before pruning can remove them)
  // --------------------------------------------------------------------------
  // Extraction uses llmConcurrency (defined above, matches OLLAMA_NUM_PARALLEL)
  if (!abortSignal?.aborted && config.enabled) {
    onPhaseStart?.("extraction");
    logger.info("memory-neo4j: [sleep] Phase 4: Entity Extraction");

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

          // Process in parallel chunks of llmConcurrency
          for (let i = 0; i < pending.length && !abortSignal?.aborted; i += llmConcurrency) {
            const chunk = pending.slice(i, i + llmConcurrency);
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
                  abortSignal,
                ),
              ),
            );

            for (const outcome of outcomes) {
              result.extraction.processed++;
              if (outcome.status === "fulfilled" && outcome.value.success) {
                result.extraction.succeeded++;
              } else {
                result.extraction.failed++;
              }
            }

            if (result.extraction.processed % 10 === 0 || i + llmConcurrency >= pending.length) {
              onProgress?.(
                "extraction",
                `${result.extraction.processed}/${result.extraction.total} processed`,
              );
            }
          }

          // Delay between batches (abort-aware)
          if (hasMore && !abortSignal?.aborted) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, extractionDelayMs);
              // If abort fires during delay, resolve immediately
              abortSignal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 4 complete — ${result.extraction.succeeded} extracted, ${result.extraction.failed} failed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 4 error: ${String(err)}`);
    }
  } else if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 4 skipped — extraction not enabled");
  }

  // --------------------------------------------------------------------------
  // Phase 5: Decay & Pruning (after extraction so freshly extracted memories
  // aren't pruned before they build entity connections)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("decay");
    logger.info("memory-neo4j: [sleep] Phase 5: Decay & Pruning");

    try {
      const decayed = await db.findDecayedMemories({
        retentionThreshold: decayRetentionThreshold,
        baseHalfLifeDays: decayBaseHalfLifeDays,
        importanceMultiplier: decayImportanceMultiplier,
        decayCurves,
        agentId,
      });

      if (decayed.length > 0) {
        const ids = decayed.map((m) => m.id);
        result.decay.memoriesPruned = await db.pruneMemories(ids);
        onProgress?.("decay", `Pruned ${result.decay.memoriesPruned} decayed memories`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 5 complete — ${result.decay.memoriesPruned} memories pruned`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 5 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 6: Orphan Cleanup
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("cleanup");
    logger.info("memory-neo4j: [sleep] Phase 6: Orphan Cleanup");

    try {
      // Clean up orphan entities
      if (!abortSignal?.aborted) {
        const orphanEntities = await db.findOrphanEntities();
        if (orphanEntities.length > 0) {
          result.cleanup.entitiesRemoved = await db.deleteOrphanEntities(
            orphanEntities.map((e) => e.id),
          );
          onProgress?.("cleanup", `Removed ${result.cleanup.entitiesRemoved} orphan entities`);
        }
      }

      // Clean up orphan tags
      if (!abortSignal?.aborted) {
        const orphanTags = await db.findOrphanTags();
        if (orphanTags.length > 0) {
          result.cleanup.tagsRemoved = await db.deleteOrphanTags(orphanTags.map((t) => t.id));
          onProgress?.("cleanup", `Removed ${result.cleanup.tagsRemoved} orphan tags`);
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 6 complete — ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} tags removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 6 error: ${String(err)}`);
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
