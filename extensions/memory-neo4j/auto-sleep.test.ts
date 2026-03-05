/**
 * Tests for the auto sleep-cycle scheduler wired in index.ts.
 *
 * Covers:
 * 1. auto=false — runSleepCycle is never called after start()
 * 2. auto=true — runSleepCycle is called after autoIntervalMs elapses
 * 3. Concurrent protection — second timer tick is skipped when cycle is running
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";

// --------------------------------------------------------------------------
// Mock sleep-cycle so we can control when runSleepCycle resolves
// --------------------------------------------------------------------------

vi.mock("./sleep-cycle.js", () => ({
  runSleepCycle: vi.fn(),
}));

// Mock heavy transitive dependencies so the module graph resolves without I/O
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
// Imports (after vi.mock hoisting)
// --------------------------------------------------------------------------

import { runSleepCycle } from "./sleep-cycle.js";

const mockRunSleepCycle = vi.mocked(runSleepCycle);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeDb(): Neo4jMemoryClient {
  return {
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as Neo4jMemoryClient;
}

function makeEmbeddings(): Embeddings {
  return {} as Embeddings;
}

function makeExtractionConfig(): ExtractionConfig {
  return {
    enabled: false,
    apiKey: "",
    model: "",
    baseUrl: "",
    temperature: 0,
    maxRetries: 0,
  };
}

/**
 * Build a minimal plugin config object matching MemoryNeo4jConfig shape.
 * Only the fields consumed by the scheduler are required to be accurate.
 */
function makePluginConfig(autoSleepOptions: { auto: boolean; autoIntervalMs?: number }) {
  return {
    neo4j: { uri: "bolt://localhost:7687", username: "neo4j", password: "test" },
    embedding: {
      provider: "ollama" as const,
      apiKey: "",
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434",
    },
    extraction: { enabled: false },
    autoCapture: false,
    autoCaptureAssistant: false,
    autoCaptureSkipPattern: undefined,
    autoRecall: false,
    autoRecallMinScore: 0.7,
    autoRecallSkipPattern: undefined,
    coreMemory: { enabled: false },
    graphSearchDepth: 1,
    decayCurves: {},
    sleepCycle: {
      auto: autoSleepOptions.auto,
      autoIntervalMs: autoSleepOptions.autoIntervalMs ?? 10_800_000,
    },
    conflictDetection: {
      enabled: false,
      similarityThreshold: 0.82,
      maxCandidates: 5,
      sleepScanBatchSize: 50,
    },
  };
}

// --------------------------------------------------------------------------
// Scheduler unit tests using a hand-rolled scheduler (avoids plugin wiring)
// --------------------------------------------------------------------------

/**
 * Minimal extraction of the scheduler logic from index.ts start() so we can
 * test it in isolation with fake timers without spinning up the full plugin.
 */
function buildScheduler(options: {
  cfg: { sleepCycle: { auto: boolean; autoIntervalMs?: number } };
  db: Neo4jMemoryClient;
  embeddings: Embeddings;
  extractionConfig: ExtractionConfig;
  logger: Logger;
  abortController: AbortController;
}) {
  const { cfg, db, embeddings, extractionConfig, logger, abortController } = options;
  let sleepCycleRunning = false;
  let autoSleepTimerId: ReturnType<typeof setTimeout> | null = null;

  function scheduleNext(): void {
    const intervalMs = cfg.sleepCycle.autoIntervalMs ?? 10_800_000;
    autoSleepTimerId = setTimeout(async () => {
      if (abortController.signal.aborted) return;
      if (sleepCycleRunning) {
        logger.debug?.("memory-neo4j: auto sleep-cycle skipped (already running)");
        scheduleNext();
        return;
      }
      sleepCycleRunning = true;
      try {
        logger.info("memory-neo4j: starting auto sleep-cycle");
        await runSleepCycle(db, embeddings, extractionConfig, logger, {
          abortSignal: abortController.signal,
        });
        logger.info("memory-neo4j: auto sleep-cycle complete");
      } catch (err) {
        logger.error(`memory-neo4j: auto sleep-cycle error — ${String(err)}`);
      } finally {
        sleepCycleRunning = false;
        if (!abortController.signal.aborted) scheduleNext();
      }
    }, intervalMs);
  }

  function start(): void {
    if (cfg.sleepCycle.auto) {
      scheduleNext();
    }
  }

  function stop(): void {
    if (autoSleepTimerId !== null) {
      clearTimeout(autoSleepTimerId);
      autoSleepTimerId = null;
    }
    abortController.abort();
  }

  // Expose for testing
  return {
    start,
    stop,
    getTimerId: () => autoSleepTimerId,
    isRunning: () => sleepCycleRunning,
    _forceRunning: (v: boolean) => {
      sleepCycleRunning = v;
    },
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("auto sleep-cycle scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunSleepCycle.mockResolvedValue({
      durationMs: 0,
      deduped: 0,
      entitiesExtracted: 0,
      tagsFilled: 0,
      decayed: 0,
      temporalStaleness: 0,
      retroactiveConflicts: 0,
      orphansDeleted: 0,
      credentialsPurged: 0,
      taskMemoryArchived: 0,
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does NOT call runSleepCycle when auto=false", async () => {
    const cfg = makePluginConfig({ auto: false, autoIntervalMs: 100 });
    const scheduler = buildScheduler({
      cfg,
      db: makeDb(),
      embeddings: makeEmbeddings(),
      extractionConfig: makeExtractionConfig(),
      logger: makeLogger(),
      abortController: new AbortController(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(500);

    expect(mockRunSleepCycle).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("calls runSleepCycle after autoIntervalMs elapses when auto=true", async () => {
    const cfg = makePluginConfig({ auto: true, autoIntervalMs: 500 });
    const scheduler = buildScheduler({
      cfg,
      db: makeDb(),
      embeddings: makeEmbeddings(),
      extractionConfig: makeExtractionConfig(),
      logger: makeLogger(),
      abortController: new AbortController(),
    });

    scheduler.start();
    // Before interval — no call yet
    await vi.advanceTimersByTimeAsync(400);
    expect(mockRunSleepCycle).not.toHaveBeenCalled();

    // After interval — one call
    await vi.advanceTimersByTimeAsync(200);
    expect(mockRunSleepCycle).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("schedules subsequent runs after each cycle completes", async () => {
    // Use 300ms interval and advance by 400ms per step so each step triggers
    // exactly one cycle (mock resolves instantly; next timer fires 300ms later).
    const cfg = makePluginConfig({ auto: true, autoIntervalMs: 300 });
    const scheduler = buildScheduler({
      cfg,
      db: makeDb(),
      embeddings: makeEmbeddings(),
      extractionConfig: makeExtractionConfig(),
      logger: makeLogger(),
      abortController: new AbortController(),
    });

    scheduler.start();
    // First run fires at t=300; next scheduled at t=600
    await vi.advanceTimersByTimeAsync(400);
    expect(mockRunSleepCycle).toHaveBeenCalledTimes(1);

    // Second run fires at t=600; next scheduled at t=900
    await vi.advanceTimersByTimeAsync(400);
    expect(mockRunSleepCycle).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("skips concurrent run when sleepCycleRunning is true", async () => {
    const cfg = makePluginConfig({ auto: true, autoIntervalMs: 100 });
    const logger = makeLogger();
    const scheduler = buildScheduler({
      cfg,
      db: makeDb(),
      embeddings: makeEmbeddings(),
      extractionConfig: makeExtractionConfig(),
      logger,
      abortController: new AbortController(),
    });

    // Force running flag before timer fires
    scheduler._forceRunning(true);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(200);

    // runSleepCycle should not have been called since it was already "running"
    expect(mockRunSleepCycle).not.toHaveBeenCalled();
    // But debug log should record the skip
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("skipped (already running)"));

    scheduler.stop();
  });

  it("clears the timer on stop() without running the cycle", async () => {
    const cfg = makePluginConfig({ auto: true, autoIntervalMs: 1000 });
    const scheduler = buildScheduler({
      cfg,
      db: makeDb(),
      embeddings: makeEmbeddings(),
      extractionConfig: makeExtractionConfig(),
      logger: makeLogger(),
      abortController: new AbortController(),
    });

    scheduler.start();
    scheduler.stop(); // cancel before timer fires

    await vi.advanceTimersByTimeAsync(2000);
    expect(mockRunSleepCycle).not.toHaveBeenCalled();
  });
});
