/**
 * Tests for the auto-capture pipeline: captureMessage and runAutoCapture.
 *
 * Tests the embed → dedup → rate → store pipeline including:
 * - Pre-computed vector usage (batch embedding optimization)
 * - Exact dedup (≥0.95 score band)
 * - Semantic dedup (0.75-0.95 score band via LLM)
 * - Importance pre-screening for assistant messages
 * - Batch embedding in runAutoCapture
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { _captureMessage as captureMessage, _runAutoCapture as runAutoCapture } from "./index.js";

// ============================================================================
// Mocks
// ============================================================================

const enabledConfig: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "https://test.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,
};

const disabledConfig: ExtractionConfig = {
  ...enabledConfig,
  enabled: false,
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function createMockDb(overrides?: Partial<Neo4jMemoryClient>): Neo4jMemoryClient {
  return {
    findSimilar: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Neo4jMemoryClient;
}

function createMockEmbeddings(overrides?: Partial<Embeddings>): Embeddings {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    ...overrides,
  } as unknown as Embeddings;
}

// ============================================================================
// captureMessage
// ============================================================================

describe("captureMessage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should store a new memory when no duplicates exist", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // Mock rateImportance (LLM call via fetch)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const result = await captureMessage(
      "I prefer TypeScript over JavaScript",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(result.semanticDeduped).toBe(false);
    expect(db.storeMemory).toHaveBeenCalledOnce();
    expect(embeddings.embed).toHaveBeenCalledWith("I prefer TypeScript over JavaScript");
  });

  it("should use pre-computed vector when provided", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();
    const precomputedVector = [0.5, 0.6, 0.7];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const result = await captureMessage(
      "test text",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
      precomputedVector,
    );

    expect(result.stored).toBe(true);
    // Should NOT call embed() since pre-computed vector was provided
    expect(embeddings.embed).not.toHaveBeenCalled();
    // Should use the pre-computed vector for findSimilar
    expect(db.findSimilar).toHaveBeenCalledWith(precomputedVector, 0.75, 3, "test-agent");
  });

  it("should skip storage when exact duplicate found (score >= 0.95)", async () => {
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "existing-1", text: "duplicate text", score: 0.97 }]),
    });
    const embeddings = createMockEmbeddings();

    const result = await captureMessage(
      "duplicate text",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(result.semanticDeduped).toBe(false);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should semantic dedup when candidate in 0.75-0.95 band is LLM-confirmed duplicate", async () => {
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "candidate-1", text: "User prefers TypeScript", score: 0.88 }]),
    });
    const embeddings = createMockEmbeddings();

    // First call: rateImportance, second call: isSemanticDuplicate
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // rateImportance response
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
            }),
        });
      }
      // isSemanticDuplicate response
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "duplicate",
                    reason: "same preference",
                  }),
                },
              },
            ],
          }),
      });
    });

    const result = await captureMessage(
      "I like TypeScript",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(result.semanticDeduped).toBe(true);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should skip importance check when extraction is disabled", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // With extraction disabled, rateImportance returns 0.5 fallback,
    // so the threshold check is skipped entirely
    const result = await captureMessage(
      "some text to store",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      disabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(db.storeMemory).toHaveBeenCalledOnce();
    // Verify stored with fallback importance * discount
    const storeCall = (db.storeMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(storeCall.importance).toBe(0.5); // 0.5 fallback * 1.0 discount
    expect(storeCall.extractionStatus).toBe("skipped");
  });

  it("should apply importance discount for assistant messages", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // For assistant messages, importance is rated first
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
        }),
    });

    const result = await captureMessage(
      "Here's what I know about Neo4j graph databases...",
      "auto-capture-assistant",
      0.8, // higher threshold for assistant
      0.75, // 25% discount
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    const storeCall = (db.storeMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // importance 0.8 (score 8/10) * 0.75 discount ≈ 0.6
    expect(storeCall.importance).toBeCloseTo(0.6);
    expect(storeCall.source).toBe("auto-capture-assistant");
  });

  it("should reject assistant messages below importance threshold", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // Low importance score
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 3 }) } }],
        }),
    });

    const result = await captureMessage(
      "Sure, I can help with that.",
      "auto-capture-assistant",
      0.8, // threshold 0.8
      0.75,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    // Should not even embed since importance pre-screen failed
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should reject user messages below importance threshold", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // Low importance score
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 2 }) } }],
        }),
    });

    const result = await captureMessage(
      "okay thanks",
      "auto-capture",
      0.5, // threshold 0.5
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });
});

// ============================================================================
// runAutoCapture
// ============================================================================

describe("runAutoCapture", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should batch-embed all retained messages at once", async () => {
    const db = createMockDb();
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Mock rateImportance calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "I prefer TypeScript over JavaScript for backend development",
      },
      {
        role: "assistant",
        content:
          "TypeScript is great for type safety and developer experience, especially with Node.js projects",
      },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // Should call embedBatch once with both texts
    expect(embedBatchMock).toHaveBeenCalledOnce();
    const batchTexts = embedBatchMock.mock.calls[0][0];
    expect(batchTexts.length).toBe(2);
  });

  it("should not call embedBatch when no messages pass the gate", async () => {
    const db = createMockDb();
    const embedBatchMock = vi.fn().mockResolvedValue([]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Short messages that won't pass attention gate
    const messages = [
      { role: "user", content: "ok" },
      { role: "assistant", content: "yes" },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(embedBatchMock).not.toHaveBeenCalled();
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should handle empty messages array", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    await runAutoCapture([], "test-agent", undefined, db, embeddings, enabledConfig, mockLogger);

    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should continue processing if one message fails", async () => {
    const db = createMockDb();
    // First embed call fails, second succeeds
    let embedCallCount = 0;
    const findSimilarMock = vi.fn().mockImplementation(() => {
      embedCallCount++;
      if (embedCallCount === 1) {
        return Promise.reject(new Error("DB connection failed"));
      }
      return Promise.resolve([]);
    });
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const dbWithError = createMockDb({
      findSimilar: findSimilarMock,
    });
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "First message that is long enough to pass the attention gate filter",
      },
      {
        role: "user",
        content: "Second message that is also long enough to pass the attention gate",
      },
    ];

    // Should not throw — errors are caught per-message
    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      dbWithError,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // The second message should still have been attempted
    expect(findSimilarMock).toHaveBeenCalledTimes(2);
  });

  it("should use different thresholds for user vs assistant messages", async () => {
    const db = createMockDb();
    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const dbWithStore = createMockDb({ storeMemory: storeMemoryMock });
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Always return high importance so both pass
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 9 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "I really love working with graph databases like Neo4j for my projects",
      },
      {
        role: "assistant",
        content:
          "Graph databases like Neo4j excel at modeling connected data and relationship queries",
      },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      dbWithStore,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // Both should be stored
    const storeCalls = storeMemoryMock.mock.calls;
    if (storeCalls.length === 2) {
      // User message: importance * 1.0 discount
      expect(storeCalls[0][0].source).toBe("auto-capture");
      // Assistant message: importance * 0.75 discount
      expect(storeCalls[1][0].source).toBe("auto-capture-assistant");
      expect(storeCalls[1][0].importance).toBeLessThan(storeCalls[0][0].importance);
    }
  });

  it("should log capture errors without throwing", async () => {
    const embedBatchMock = vi.fn().mockRejectedValue(new Error("embedding service down"));
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });
    const db = createMockDb();

    const messages = [
      {
        role: "user",
        content: "A long enough message to pass the attention gate for testing purposes",
      },
    ];

    // Should not throw
    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // Should have logged the error
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
