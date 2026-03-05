/**
 * Tests for the runSleepCycle orchestrator.
 *
 * Covers: abort short-circuit, onPhaseStart callback, result shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { runSleepCycle } from "./sleep-cycle.js";

// --------------------------------------------------------------------------
// Mock heavy dependencies so the orchestrator doesn't make real I/O calls
// --------------------------------------------------------------------------

vi.mock("./llm-client.js", () => ({
  callOpenRouter: vi.fn(),
  callOpenRouterStream: vi.fn(),
  isTransientError: vi.fn(() => false),
}));

vi.mock("./extractor.js", () => ({
  classifyTemporalStaleness: vi.fn(),
  extractTagsOnly: vi.fn(),
  isSemanticDuplicate: vi.fn(),
  resolveConflict: vi.fn(),
  runBackgroundExtraction: vi.fn(),
  stripCodeFences: vi.fn((s: string) => s),
}));

vi.mock("./task-ledger.js", () => ({
  parseTaskLedger: vi.fn(),
  reviewAndArchiveStaleTasks: vi.fn(),
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createMockDb(): Neo4jMemoryClient {
  return {
    findDuplicateClusters: vi.fn().mockResolvedValue([]),
    mergeMemoryCluster: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    findConflictingMemories: vi.fn().mockResolvedValue([]),
    invalidateMemory: vi.fn().mockResolvedValue(undefined),
    reconcileEntityMentionCounts: vi.fn().mockResolvedValue(0),
    findDuplicateEntityPairs: vi.fn().mockResolvedValue([]),
    mergeEntityPair: vi.fn().mockResolvedValue(false),
    countByExtractionStatus: vi
      .fn()
      .mockResolvedValue({ pending: 0, complete: 0, failed: 0, skipped: 0 }),
    listPendingExtractions: vi.fn().mockResolvedValue([]),
    batchEntityOperations: vi.fn().mockResolvedValue(undefined),
    incrementTaggingRetries: vi.fn().mockResolvedValue(undefined),
    listUntaggedMemories: vi.fn().mockResolvedValue([]),
    findDecayedMemories: vi.fn().mockResolvedValue([]),
    pruneMemories: vi.fn().mockResolvedValue(0),
    fetchMemoriesForTemporalCheck: vi.fn().mockResolvedValue([]),
    fetchMemoriesForRetroactiveConflictScan: vi.fn().mockResolvedValue([]),
    detectConflicts: vi.fn().mockResolvedValue(0),
    findOrphanEntities: vi.fn().mockResolvedValue([]),
    deleteOrphanEntities: vi.fn().mockResolvedValue(0),
    findOrphanTags: vi.fn().mockResolvedValue([]),
    deleteOrphanTags: vi.fn().mockResolvedValue(0),
    findSingleUseTags: vi.fn().mockResolvedValue([]),
    deleteMemoriesByPattern: vi.fn().mockResolvedValue(0),
    fetchMemoriesForCredentialScan: vi.fn().mockResolvedValue([]),
    deleteMemoriesByIds: vi.fn().mockResolvedValue(0),
    searchMemoriesByKeywords: vi.fn().mockResolvedValue([]),
    findSimilar: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue("mem-id"),
  } as unknown as Neo4jMemoryClient;
}

function createMockEmbeddings(): Embeddings {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
  } as unknown as Embeddings;
}

const baseConfig: ExtractionConfig = {
  enabled: false, // disable LLM-dependent phases
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "http://localhost:8080",
  temperature: 0,
  maxRetries: 0,
};

// Options that skip all LLM-dependent phases for fast, deterministic tests
const fastOptions = {
  skipSemanticDedup: true,
  skipTemporalStaleness: true,
  skipRetroactiveConflictScan: true,
  skipRetroactiveTagging: true,
  skipTaskMemoryCleanup: true,
  skipTipGeneration: true,
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("runSleepCycle orchestrator", () => {
  let db: Neo4jMemoryClient;
  let embeddings: Embeddings;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    embeddings = createMockEmbeddings();
    logger = createMockLogger();
  });

  it("returns aborted:true immediately when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, {
      abortSignal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    // No db methods should have been called since the signal was already aborted
    expect(db.findDuplicateClusters).not.toHaveBeenCalled();
  });

  it("invokes onPhaseStart callback with 'dedup' phase", async () => {
    const onPhaseStart = vi.fn();

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
      onPhaseStart,
    });

    expect(onPhaseStart).toHaveBeenCalledWith("dedup");
  });

  it("invokes onPhaseStart for multiple phases in order", async () => {
    const phases: string[] = [];
    const onPhaseStart = vi.fn((phase: string) => phases.push(phase));

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
      onPhaseStart,
    });

    // dedup and entityDedup always run; cleanup, noiseCleanup, credentialScan also run
    expect(phases).toContain("dedup");
    expect(phases).toContain("entityDedup");
    expect(phases).toContain("cleanup");
  });

  it("returns result with expected shape and zero counts when no work to do", async () => {
    const result = await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify shape of all top-level result keys
    expect(result.dedup).toMatchObject({ clustersFound: 0, memoriesMerged: 0 });
    expect(result.conflict).toMatchObject({ pairsFound: 0, resolved: 0, invalidated: 0 });
    expect(result.semanticDedup).toMatchObject({ pairsChecked: 0, duplicatesMerged: 0 });
    expect(result.entityDedup).toMatchObject({ pairsFound: 0, merged: 0 });
    expect(result.extraction).toMatchObject({ total: 0, processed: 0, succeeded: 0, failed: 0 });
    expect(result.decay).toMatchObject({ memoriesPruned: 0 });
    expect(result.temporalStaleness).toMatchObject({ memoriesChecked: 0, memoriesRemoved: 0 });
    expect(result.cleanup).toMatchObject({ entitiesRemoved: 0, tagsRemoved: 0 });
    expect(result.credentialScan).toMatchObject({
      memoriesScanned: 0,
      credentialsFound: 0,
      memoriesRemoved: 0,
    });
    expect(result.taskLedger).toMatchObject({ staleCount: 0, archivedCount: 0 });
    expect(result.taskMemoryCleanup).toMatchObject({
      tasksChecked: 0,
      memoriesEvaluated: 0,
      memoriesRemoved: 0,
    });
  });

  it("queries db.findDuplicateClusters during the dedup phase", async () => {
    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    expect(db.findDuplicateClusters).toHaveBeenCalledWith(0.75, undefined, true);
  });
});
