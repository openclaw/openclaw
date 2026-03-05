/**
 * Tests for cli.ts — specifically the OP-95 gap fix:
 * the sleep command must create an AbortController and pass its signal to runSleepCycle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCli } from "./cli.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { runSleepCycle } from "./sleep-cycle.js";

// Mock sleep-cycle so the sleep command doesn't do real I/O
vi.mock("./sleep-cycle.js", () => ({
  runSleepCycle: vi.fn(),
}));

// Minimal SleepCycleResult to satisfy the CLI reporting code
const STUB_RESULT = {
  dedup: { clustersFound: 0, memoriesMerged: 0 },
  conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
  semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
  entityDedup: { pairsFound: 0, merged: 0 },
  extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
  retroactiveTagging: { total: 0, tagged: 0, failed: 0 },
  decay: { memoriesPruned: 0 },
  temporalStaleness: { memoriesChecked: 0, memoriesRemoved: 0 },
  retroactiveConflictScan: { memoriesScanned: 0, memoriesSuperseded: 0 },
  cleanup: { entitiesRemoved: 0, tagsRemoved: 0, singleUseTagsRemoved: 0 },
  credentialScan: { memoriesScanned: 0, credentialsFound: 0, memoriesRemoved: 0 },
  taskLedger: { staleCount: 0, archivedCount: 0, archivedIds: [] },
  taskMemoryCleanup: { tasksChecked: 0, memoriesEvaluated: 0, memoriesRemoved: 0 },
  tipGeneration: { sessionsScanned: 0, failurePatternsFound: 0, tipsGenerated: 0, tipsStored: 0 },
  durationMs: 10,
  aborted: false,
};

/**
 * Build a minimal fluent commander-style command mock.
 * Stores action handlers keyed by their command name in `handlerStore`.
 */
function makeMock(
  name: string,
  handlerStore: Record<string, (...args: unknown[]) => Promise<void>>,
): Record<string, unknown> {
  const mock: Record<string, unknown> = {
    name: () => name,
    description: () => mock,
    option: () => mock,
    argument: () => mock,
    command: (sub: string) => makeMock(sub, handlerStore),
    action: (handler: (...args: unknown[]) => Promise<void>) => {
      handlerStore[name] = handler;
      return mock;
    },
    commands: [],
  };
  return mock;
}

describe("CLI sleep command — OP-95 gap: AbortController wired to runSleepCycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an AbortSignal to runSleepCycle when the sleep command runs", async () => {
    vi.mocked(runSleepCycle).mockResolvedValue(STUB_RESULT as never);

    // Silence console output from the sleep command handler
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const handlerStore: Record<string, (...args: unknown[]) => Promise<void>> = {};
    const program = makeMock("root", handlerStore);

    const db = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Neo4jMemoryClient;

    const api = {
      registerCli: (fn: (args: { program: unknown }) => void) => fn({ program }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    const cfg = {
      neo4j: { uri: "bolt://localhost:7687" },
      sleepCycle: {},
      decayCurves: {},
    } as unknown as MemoryNeo4jConfig;

    const extractionConfig: ExtractionConfig = {
      enabled: false,
      apiKey: "test",
      model: "test",
      baseUrl: "http://localhost",
      temperature: 0,
      maxRetries: 0,
    };

    registerCli(api as never, {
      db,
      embeddings: {} as unknown as Embeddings,
      cfg,
      extractionConfig,
      vectorDim: 1536,
    });

    // Invoke the sleep command handler with empty opts (all defaults)
    expect(handlerStore["sleep"]).toBeDefined();
    await handlerStore["sleep"]({});

    // runSleepCycle must have been called with an AbortSignal
    expect(runSleepCycle).toHaveBeenCalledOnce();
    const callOpts = vi.mocked(runSleepCycle).mock.calls[0][4] as Record<string, unknown>;
    expect(callOpts).toHaveProperty("abortSignal");
    expect(callOpts.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
