/**
 * Multi-phase sleep cycle for memory consolidation.
 *
 * Phases:
 * 1.  DEDUPLICATION - Merge near-duplicate memories (reduce redundancy)
 * 1b. SEMANTIC DEDUP - LLM-based paraphrase detection
 * 1c. CONFLICT DETECTION - Resolve contradictory memories
 * 1d. ENTITY DEDUP - Merge near-duplicate entities (reduce entity bloat)
 * 2.  EXTRACTION - Form entity relationships (strengthen connections)
 * 3.  DECAY/PRUNING - Remove old, low-importance memories (forgetting curve)
 * 4.  CLEANUP - Remove orphaned entities/tags (garbage collection)
 * 5.  NOISE CLEANUP - Remove dangerous pattern memories
 * 5b. CREDENTIAL SCAN - Remove memories containing leaked credentials
 * 6.  TASK LEDGER - Archive stale tasks in TASKS.md
 * 7.  TASK-MEMORY CLEANUP - Remove task-noise memories for completed tasks
 *
 * Research basis:
 * - ACT-R memory model for retrieval-based importance
 * - Ebbinghaus forgetting curve for decay
 * - MemGPT/Letta for tiered memory architecture
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import {
  extractTagsOnly,
  isSemanticDuplicate,
  resolveConflict,
  runBackgroundExtraction,
} from "./extractor.js";
import { callOpenRouter } from "./llm-client.js";
import { makePairKey } from "./schema.js";
import {
  parseTaskLedger,
  reviewAndArchiveStaleTasks,
  type StaleTaskResult,
} from "./task-ledger.js";

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
  // Phase 1d: Entity Deduplication
  entityDedup: {
    pairsFound: number;
    merged: number;
  };
  // Phase 2: Entity Extraction
  extraction: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  // Phase 2b: Retroactive Tagging
  retroactiveTagging: {
    total: number;
    tagged: number;
    failed: number;
  };
  // Phase 3: Decay & Pruning
  decay: {
    memoriesPruned: number;
  };
  // Phase 4: Orphan Cleanup
  cleanup: {
    entitiesRemoved: number;
    tagsRemoved: number;
    singleUseTagsRemoved: number;
  };
  // Phase 5b: Credential Scanning
  credentialScan: {
    memoriesScanned: number;
    credentialsFound: number;
    memoriesRemoved: number;
  };
  // Phase 6: Task Ledger Cleanup
  taskLedger: {
    staleCount: number;
    archivedCount: number;
    archivedIds: string[];
  };
  // Phase 7: Task-Memory Cleanup
  taskMemoryCleanup: {
    tasksChecked: number;
    memoriesEvaluated: number;
    memoriesRemoved: number;
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

  // Phase 1b: Semantic Dedup
  maxSemanticDedupPairs?: number; // Max LLM-checked pairs (default: 500)

  // Concurrency
  llmConcurrency?: number; // Parallel LLM calls (default: 8, match OLLAMA_NUM_PARALLEL)

  // Phase 2: Extraction
  extractionBatchSize?: number; // Memories per batch (default: 50)
  extractionDelayMs?: number; // Delay between batches (default: 1000)

  // Phase 2b: Retroactive Tagging
  skipRetroactiveTagging?: boolean; // Skip retroactive tagging (default: false)
  retroactiveTagBatchSize?: number; // Memories per batch (default: 50)

  // Phase 4: Cleanup
  singleUseTagMinAgeDays?: number; // Min age before single-use tag pruning (default: 14)

  // Phase 3: Decay
  decayRetentionThreshold?: number; // Below this, memory is pruned (default: 0.1)
  decayBaseHalfLifeDays?: number; // Base half-life in days (default: 30)
  decayImportanceMultiplier?: number; // How much importance extends half-life (default: 2)
  decayCurves?: Record<string, { halfLifeDays: number }>; // Per-category decay curve overrides

  // Phase 6: Task Ledger
  workspaceDir?: string; // Workspace dir for TASKS.md (default: resolved from env)
  staleTaskMaxAgeMs?: number; // Max age before task is stale (default: 24h)

  // Phase 7: Task-Memory Cleanup
  skipTaskMemoryCleanup?: boolean; // Skip task-memory cleanup (default: false)
  taskMemoryMaxAgeDays?: number; // Only check tasks completed within this many days (default: 7)

  // Progress callback
  onPhaseStart?: (
    phase:
      | "dedup"
      | "conflict"
      | "semanticDedup"
      | "entityDedup"
      | "decay"
      | "extraction"
      | "retroactiveTagging"
      | "cleanup"
      | "noiseCleanup"
      | "credentialScan"
      | "taskLedger"
      | "taskMemoryCleanup",
  ) => void;
  onProgress?: (phase: string, message: string) => void;
};

// ============================================================================
// Credential Detection Patterns
// ============================================================================

/**
 * Regex patterns that match credential-like content in memory text.
 * Used by the credential scanning phase to find and remove memories
 * that accidentally stored secrets, passwords, API keys, or tokens.
 *
 * These are JavaScript RegExp patterns (case-insensitive).
 */
export const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // API keys: sk-..., api_key_..., api_key_live_..., apikey-..., etc.
  { pattern: /\b(?:sk|api[_-]?key(?:[_-]\w+)?)[_-][a-z0-9]{16,}/i, label: "API key" },

  // Bearer tokens
  { pattern: /bearer\s+[a-z0-9_\-.]{20,}/i, label: "Bearer token" },

  // JWT tokens (three base64 segments separated by dots) — check before generic token pattern
  { pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/i, label: "JWT" },

  // Generic long tokens/secrets (hex or base64, 32+ chars)
  {
    pattern: /\b(?:token|secret|key)\s*[:=]\s*["']?[a-z0-9+/=_\-]{32,}["']?/i,
    label: "Token/secret",
  },

  // Password patterns: password: X, password=X, password X, passwd=X, pwd=X
  {
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?\S{4,}["']?/i,
    label: "Password assignment",
  },

  // Credentials in "creds user/pass" format: "login with X creds user/pass"
  { pattern: /\bcreds?\s+\S+[/\\]\S+/i, label: "Credentials (user/pass)" },

  // URL-embedded credentials: https://user:pass@host
  { pattern: /\/\/[^/\s:]+:[^/\s@]+@/i, label: "URL credentials" },

  // Private keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i, label: "Private key" },

  // AWS-style keys
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, label: "AWS key" },

  // GitHub/GitLab tokens
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr|glpat)[_-][a-zA-Z0-9]{16,}/i, label: "GitHub/GitLab token" },
];

/**
 * Check if a text contains credential-like content.
 * Returns the first matching pattern label, or null if clean.
 */
export function detectCredential(text: string): string | null {
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}

// ============================================================================
// Task-Memory Classification
// ============================================================================

/**
 * Use LLM to classify whether a memory is "lasting" (valuable independent
 * of the completed task) or "noise" (only useful while the task was active).
 *
 * Conservative: returns "lasting" on any failure to avoid deleting valuable memories.
 */
export async function classifyTaskMemory(
  memoryText: string,
  taskTitle: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"lasting" | "noise"> {
  if (!config.enabled) {
    return "lasting";
  }

  try {
    const content = await callOpenRouter(
      config,
      [
        {
          role: "system",
          content: `A task titled "${taskTitle}" has been completed. The following memory was created during this task.

Classify this memory:
- "lasting" if it contains a decision, preference, fact, or knowledge that is valuable INDEPENDENT of the task
- "noise" if it contains task progress, debugging steps, intermediate state, or context that is only useful while the task was active

When in doubt, choose "lasting". It is better to keep some noise than to delete valuable knowledge.

Return JSON: {"classification": "lasting"|"noise", "reason": "brief explanation"}`,
        },
        { role: "user", content: memoryText },
      ],
      abortSignal,
    );

    if (!content) {
      return "lasting";
    }

    const parsed = JSON.parse(content) as { classification?: string };
    if (parsed.classification === "noise") {
      return "noise";
    }
    return "lasting";
  } catch {
    // On any failure, keep the memory (conservative)
    return "lasting";
  }
}

// ============================================================================
// Sleep Cycle Implementation
// ============================================================================

/**
 * Run the full sleep cycle - seven phases of memory consolidation.
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
    decayRetentionThreshold = 0.1,
    decayBaseHalfLifeDays = 30,
    decayImportanceMultiplier = 2,
    decayCurves,
    extractionBatchSize = 50,
    extractionDelayMs = 1000,
    skipRetroactiveTagging = false,
    retroactiveTagBatchSize = 50,
    singleUseTagMinAgeDays = 14,
    workspaceDir,
    staleTaskMaxAgeMs,
    skipTaskMemoryCleanup = false,
    taskMemoryMaxAgeDays = 7,
    onPhaseStart,
    onProgress,
  } = options;

  const result: SleepCycleResult = {
    dedup: { clustersFound: 0, memoriesMerged: 0 },
    conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
    semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
    entityDedup: { pairsFound: 0, merged: 0 },
    decay: { memoriesPruned: 0 },
    extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
    retroactiveTagging: { total: 0, tagged: 0, failed: 0 },
    cleanup: { entitiesRemoved: 0, tagsRemoved: 0, singleUseTagsRemoved: 0 },
    credentialScan: { memoriesScanned: 0, credentialsFound: 0, memoriesRemoved: 0 },
    taskLedger: { staleCount: 0, archivedCount: 0, archivedIds: [] },
    taskMemoryCleanup: { tasksChecked: 0, memoriesEvaluated: 0, memoriesRemoved: 0 },
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
  // Phase 1d: Entity Deduplication
  // Merge entities where one name is a substring of another (same type).
  // Catches: "fish speech" → "fish speech s1 mini", "aaditya" → "aaditya sukhani"
  // Transfers MENTIONS relationships to the canonical entity, then deletes the duplicate.
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("entityDedup");
    logger.info("memory-neo4j: [sleep] Phase 1d: Entity Deduplication");

    try {
      // Reconcile NULL mentionCounts before dedup so decisions are based on accurate counts
      const reconciled = await db.reconcileEntityMentionCounts();
      if (reconciled > 0) {
        logger.info(
          `memory-neo4j: [sleep] Phase 1d: Reconciled mentionCount for ${reconciled} entities`,
        );
        onProgress?.("entityDedup", `Reconciled ${reconciled} entity mention counts`);
      }

      const pairs = await db.findDuplicateEntityPairs(agentId);
      result.entityDedup.pairsFound = pairs.length;

      // Track removed entity IDs to skip cascading merges on already-deleted entities
      const removedIds = new Set<string>();

      for (const pair of pairs) {
        if (abortSignal?.aborted) {
          break;
        }
        // Skip if either entity was already removed in a previous merge
        if (removedIds.has(pair.keepId) || removedIds.has(pair.removeId)) {
          continue;
        }

        const merged = await db.mergeEntityPair(pair.keepId, pair.removeId);
        if (merged) {
          removedIds.add(pair.removeId);
          result.entityDedup.merged++;
          onProgress?.(
            "entityDedup",
            `Merged "${pair.removeName}" → "${pair.keepName}" (${pair.removeMentions} mentions transferred)`,
          );
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1d complete — ${result.entityDedup.pairsFound} pairs found, ${result.entityDedup.merged} merged`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 1d error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 2: Entity Extraction (before decay so new memories get
  // extracted before pruning can remove them)
  // --------------------------------------------------------------------------
  // Extraction uses llmConcurrency (defined above, matches OLLAMA_NUM_PARALLEL)
  if (!abortSignal?.aborted && config.enabled) {
    onPhaseStart?.("extraction");
    logger.info("memory-neo4j: [sleep] Phase 2: Entity Extraction");

    try {
      // Get initial count
      const counts = await db.countByExtractionStatus(agentId);
      result.extraction.total = counts.pending + counts.skipped;

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
        `memory-neo4j: [sleep] Phase 2 complete — ${result.extraction.succeeded} extracted, ${result.extraction.failed} failed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 2 error: ${String(err)}`);
    }
  } else if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 2 skipped — extraction not enabled");
  }

  // --------------------------------------------------------------------------
  // Phase 2b: Retroactive Tagging
  // Find memories with completed extraction but no tags, and generate tags
  // using a lightweight LLM prompt. This fixes the historical gap where
  // the extraction prompt treated tags as optional.
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && config.enabled && !skipRetroactiveTagging) {
    onPhaseStart?.("retroactiveTagging");
    logger.info("memory-neo4j: [sleep] Phase 2b: Retroactive Tagging");

    try {
      let hasMore = true;
      while (hasMore && !abortSignal?.aborted) {
        const untagged = await db.listUntaggedMemories(retroactiveTagBatchSize, agentId);

        if (untagged.length === 0) {
          hasMore = false;
          break;
        }

        // Count total on first batch
        if (result.retroactiveTagging.total === 0) {
          result.retroactiveTagging.total = untagged.length;
        }

        // Process in parallel chunks of llmConcurrency
        for (let i = 0; i < untagged.length && !abortSignal?.aborted; i += llmConcurrency) {
          const chunk = untagged.slice(i, i + llmConcurrency);
          const outcomes = await Promise.allSettled(
            chunk.map((memory) => extractTagsOnly(memory.text, config, abortSignal)),
          );

          for (let k = 0; k < outcomes.length; k++) {
            const outcome = outcomes[k];
            const memory = chunk[k];

            if (outcome.status === "fulfilled" && outcome.value && outcome.value.length > 0) {
              try {
                await db.batchEntityOperations(memory.id, [], [], outcome.value);
                result.retroactiveTagging.tagged++;
                onProgress?.(
                  "retroactiveTagging",
                  `Tagged "${memory.text.slice(0, 50)}..." with ${outcome.value.length} tags`,
                );
              } catch (err) {
                result.retroactiveTagging.failed++;
                logger.warn(
                  `memory-neo4j: [sleep] retroactive tagging write failed for ${memory.id.slice(0, 8)}: ${String(err)}`,
                );
              }
            } else {
              result.retroactiveTagging.failed++;
            }
          }
        }

        // Check if there are more untagged memories
        const nextBatch = await db.listUntaggedMemories(1, agentId);
        hasMore = nextBatch.length > 0;

        // Delay between batches (abort-aware)
        if (hasMore && !abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, extractionDelayMs);
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

      logger.info(
        `memory-neo4j: [sleep] Phase 2b complete — ${result.retroactiveTagging.tagged} tagged, ${result.retroactiveTagging.failed} failed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 2b error: ${String(err)}`);
    }
  } else if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 2b skipped — extraction not enabled");
  } else if (skipRetroactiveTagging) {
    logger.info("memory-neo4j: [sleep] Phase 2b skipped — retroactive tagging disabled");
  }

  // --------------------------------------------------------------------------
  // Phase 3: Decay & Pruning (after extraction so freshly extracted memories
  // aren't pruned before they build entity connections)
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("decay");
    logger.info("memory-neo4j: [sleep] Phase 3: Decay & Pruning");

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
        `memory-neo4j: [sleep] Phase 3 complete — ${result.decay.memoriesPruned} memories pruned`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 3 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 4: Orphan Cleanup
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("cleanup");
    logger.info("memory-neo4j: [sleep] Phase 4: Orphan Cleanup");

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

      // Prune single-use tags (only 1 memory reference, older than threshold)
      // These add noise without providing useful cross-memory connections.
      if (!abortSignal?.aborted) {
        const singleUseTags = await db.findSingleUseTags(singleUseTagMinAgeDays);
        if (singleUseTags.length > 0) {
          result.cleanup.singleUseTagsRemoved = await db.deleteOrphanTags(
            singleUseTags.map((t) => t.id),
          );
          onProgress?.(
            "cleanup",
            `Removed ${result.cleanup.singleUseTagsRemoved} single-use tags (>${singleUseTagMinAgeDays}d old)`,
          );
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 4 complete — ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} orphan tags, ${result.cleanup.singleUseTagsRemoved} single-use tags removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 4 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 5: Noise Pattern Cleanup
  // Removes memories matching dangerous patterns that should never have been
  // stored (open proposals, action items that trigger rogue sessions).
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("noiseCleanup");
    logger.info("memory-neo4j: [sleep] Phase 5: Noise Pattern Cleanup");

    try {
      const noisePatterns = [
        "(?i)want me to\\s.+\\?",
        "(?i)should I\\s.+\\?",
        "(?i)shall I\\s.+\\?",
        "(?i)would you like me to\\s.+\\?",
        "(?i)do you want me to\\s.+\\?",
        "(?i)ready to\\s.+\\?",
        "(?i)proceed with\\s.+\\?",
      ];

      let noiseRemoved = 0;
      for (const pattern of noisePatterns) {
        if (abortSignal?.aborted) {
          break;
        }
        noiseRemoved += await db.deleteMemoriesByPattern(`.*${pattern}.*`, agentId);
      }

      if (noiseRemoved > 0) {
        onProgress?.("cleanup", `Removed ${noiseRemoved} noise-pattern memories`);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 5 complete — ${noiseRemoved} noise memories removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 5 error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 5b: Credential Scanning
  // Scans all memories for accidentally stored credentials (API keys,
  // passwords, tokens) and removes them. This is a security measure
  // to prevent credential leaks in the memory store.
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted) {
    onPhaseStart?.("credentialScan");
    logger.info("memory-neo4j: [sleep] Phase 5b: Credential Scanning");

    try {
      const allMemories = await db.fetchAllMemoriesForScan(agentId);
      result.credentialScan.memoriesScanned = allMemories.length;

      const toRemove: string[] = [];
      for (const { id, text } of allMemories) {
        if (abortSignal?.aborted) {
          break;
        }
        const matched = detectCredential(text);
        if (matched) {
          toRemove.push(id);
          result.credentialScan.credentialsFound++;
          onProgress?.(
            "credentialScan",
            `Found ${matched} in memory ${id.slice(0, 8)}...: "${text.slice(0, 40)}..."`,
          );
          logger.warn(
            `memory-neo4j: [sleep] Credential detected (${matched}) in memory ${id} — removing`,
          );
        }
      }

      if (toRemove.length > 0) {
        result.credentialScan.memoriesRemoved = await db.deleteMemoriesByIds(toRemove);
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 5b complete — ${result.credentialScan.memoriesScanned} scanned, ${result.credentialScan.credentialsFound} credentials found, ${result.credentialScan.memoriesRemoved} removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 5b error: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 6: Task Ledger Cleanup
  // Reviews TASKS.md for stale tasks (>24h with no activity) and archives them.
  // Requires workspaceDir to be provided (otherwise skipped).
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && workspaceDir) {
    onPhaseStart?.("taskLedger");
    logger.info("memory-neo4j: [sleep] Phase 6: Task Ledger Cleanup");

    try {
      const staleResult = await reviewAndArchiveStaleTasks(workspaceDir, staleTaskMaxAgeMs);

      if (staleResult) {
        result.taskLedger.staleCount = staleResult.staleCount;
        result.taskLedger.archivedCount = staleResult.archivedCount;
        result.taskLedger.archivedIds = staleResult.archivedIds;

        if (staleResult.archivedCount > 0) {
          onProgress?.(
            "taskLedger",
            `Archived ${staleResult.archivedCount} stale tasks: ${staleResult.archivedIds.join(", ")}`,
          );
        } else {
          onProgress?.("taskLedger", "No stale tasks found");
        }
      } else {
        onProgress?.("taskLedger", "TASKS.md not found — skipped");
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 6 complete — ${result.taskLedger.archivedCount} stale tasks archived`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 6 error: ${String(err)}`);
    }
  } else if (!workspaceDir) {
    logger.info("memory-neo4j: [sleep] Phase 6: Task Ledger Cleanup — SKIPPED (no workspace dir)");
  }

  // --------------------------------------------------------------------------
  // Phase 7: Task-Memory Cleanup
  // Cross-references completed tasks (from TASKS.md) with stored memories.
  // For each completed task (within the last N days), searches for memories
  // mentioning that task and uses LLM to classify them as "lasting" (keep)
  // vs "noise" (delete). This prevents stale task-specific memories from
  // being recalled after tasks are done.
  // --------------------------------------------------------------------------
  if (!abortSignal?.aborted && workspaceDir && config.enabled && !skipTaskMemoryCleanup) {
    onPhaseStart?.("taskMemoryCleanup");
    logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup");

    try {
      const tasksPath = path.join(workspaceDir, "TASKS.md");
      let tasksContent: string | null = null;
      try {
        tasksContent = await fs.readFile(tasksPath, "utf-8");
      } catch {
        // TASKS.md doesn't exist — skip
      }

      if (tasksContent) {
        const ledger = parseTaskLedger(tasksContent);
        const now = new Date();
        const maxAgeMs = taskMemoryMaxAgeDays * 24 * 60 * 60 * 1000;

        // Filter to recently completed tasks (within maxAgeDays)
        const recentCompleted = ledger.completedTasks.filter((task) => {
          // Use the "Completed" field, "Updated" field, or "Started" field as date source
          const dateStr =
            task.details?.match(/Completed:\s*(\S+)/)?.[1] || task.updated || task.started;
          if (!dateStr) {
            return false;
          }
          // Try to parse date — accept formats like "2026-02-16", "2026-02-16 09:15"
          const cleaned = dateStr
            .trim()
            .replace(/\s+[A-Z]{2,5}$/, "")
            .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");
          const date = new Date(cleaned);
          if (Number.isNaN(date.getTime())) {
            return false;
          }
          return now.getTime() - date.getTime() <= maxAgeMs;
        });

        result.taskMemoryCleanup.tasksChecked = recentCompleted.length;

        if (recentCompleted.length > 0) {
          onProgress?.(
            "taskMemoryCleanup",
            `Found ${recentCompleted.length} recently completed tasks to check`,
          );

          // Collect all memories to evaluate across all tasks (dedup by id)
          const memoriesToEvaluate = new Map<
            string,
            { id: string; text: string; category: string; taskTitle: string }
          >();

          for (const task of recentCompleted) {
            if (abortSignal?.aborted) break;

            // Build keywords from task ID and title words
            const keywords = [task.id];
            const titleWords = task.title
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .map((w) => w.replace(/[^a-zA-Z0-9-]/g, ""))
              .filter((w) => w.length > 3);
            keywords.push(...titleWords);

            const matches = await db.searchMemoriesByKeywords(keywords, 50, agentId);

            for (const mem of matches) {
              // Skip core memories — those are user-curated
              if (mem.category === "core") continue;
              if (!memoriesToEvaluate.has(mem.id)) {
                memoriesToEvaluate.set(mem.id, { ...mem, taskTitle: task.title });
              }
            }
          }

          // Classify memories in parallel batches using LLM
          const toEvaluate = [...memoriesToEvaluate.values()];
          result.taskMemoryCleanup.memoriesEvaluated = toEvaluate.length;

          if (toEvaluate.length > 0) {
            onProgress?.("taskMemoryCleanup", `Evaluating ${toEvaluate.length} memories with LLM`);
          }

          const toRemove: string[] = [];

          for (let i = 0; i < toEvaluate.length && !abortSignal?.aborted; i += llmConcurrency) {
            const batch = toEvaluate.slice(i, i + llmConcurrency);

            const outcomes = await Promise.allSettled(
              batch.map((mem) => classifyTaskMemory(mem.text, mem.taskTitle, config, abortSignal)),
            );

            for (let k = 0; k < outcomes.length; k++) {
              const outcome = outcomes[k];
              const mem = batch[k];

              if (outcome.status === "fulfilled" && outcome.value === "noise") {
                toRemove.push(mem.id);
                onProgress?.(
                  "taskMemoryCleanup",
                  `Noise: "${mem.text.slice(0, 60)}..." (task: ${mem.taskTitle})`,
                );
              } else if (outcome.status === "fulfilled" && outcome.value === "lasting") {
                onProgress?.("taskMemoryCleanup", `Lasting: "${mem.text.slice(0, 60)}..."`);
              }
              // On failure, keep the memory (conservative)
            }
          }

          // Remove noise memories
          if (toRemove.length > 0 && !abortSignal?.aborted) {
            for (const id of toRemove) {
              if (abortSignal?.aborted) break;
              await db.invalidateMemory(id);
            }
            result.taskMemoryCleanup.memoriesRemoved = toRemove.length;
            onProgress?.("taskMemoryCleanup", `Invalidated ${toRemove.length} task-noise memories`);
          }
        } else {
          onProgress?.("taskMemoryCleanup", "No recently completed tasks found");
        }
      } else {
        onProgress?.("taskMemoryCleanup", "TASKS.md not found — skipped");
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 7 complete — ${result.taskMemoryCleanup.tasksChecked} tasks checked, ${result.taskMemoryCleanup.memoriesEvaluated} memories evaluated, ${result.taskMemoryCleanup.memoriesRemoved} removed`,
      );
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] Phase 7 error: ${String(err)}`);
    }
  } else if (!workspaceDir) {
    logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (no workspace dir)");
  } else if (!config.enabled) {
    logger.info(
      "memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (extraction not enabled)",
    );
  } else if (skipTaskMemoryCleanup) {
    logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (disabled)");
  }

  result.durationMs = Date.now() - startTime;
  result.aborted = abortSignal?.aborted ?? false;

  logger.info(
    `memory-neo4j: [sleep] Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s` +
      (result.aborted ? " (aborted)" : ""),
  );

  return result;
}
