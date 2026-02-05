/**
 * Tests for search.ts — Hybrid Search & RRF Fusion.
 *
 * Tests the exported pure logic: classifyQuery() and getAdaptiveWeights().
 * Note: fuseWithConfidenceRRF() is not exported (private module-level function)
 * and is tested indirectly through hybridSearch().
 * hybridSearch() is tested with mocked Neo4j client and Embeddings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchSignalResult } from "./schema.js";
import { classifyQuery, getAdaptiveWeights, hybridSearch } from "./search.js";

// ============================================================================
// classifyQuery()
// ============================================================================

describe("classifyQuery", () => {
  describe("short queries (1-2 words)", () => {
    it("should classify a single word as 'short'", () => {
      expect(classifyQuery("dogs")).toBe("short");
    });

    it("should classify two words as 'short'", () => {
      expect(classifyQuery("best coffee")).toBe("short");
    });

    it("should classify a single capitalized word as 'short' (word count takes priority)", () => {
      expect(classifyQuery("TypeScript")).toBe("short");
    });

    it("should handle whitespace-padded short queries", () => {
      expect(classifyQuery("  hello  ")).toBe("short");
    });
  });

  describe("entity queries (proper nouns)", () => {
    it("should classify query with proper noun as 'entity'", () => {
      expect(classifyQuery("tell me about Tarun")).toBe("entity");
    });

    it("should classify query with organization name as 'entity'", () => {
      expect(classifyQuery("what about Google")).toBe("entity");
    });

    it("should classify question patterns targeting entities", () => {
      expect(classifyQuery("who is the CEO")).toBe("entity");
    });

    it("should classify 'where is' patterns as entity", () => {
      expect(classifyQuery("where is the office")).toBe("entity");
    });

    it("should classify 'what does' patterns as entity", () => {
      expect(classifyQuery("what does she do")).toBe("entity");
    });

    it("should not treat common words (The, Is, etc.) as entity indicators", () => {
      // "The" and "Is" are excluded from capitalized word detection
      // 3 words, no proper nouns detected, no question pattern -> default
      expect(classifyQuery("this is fine")).toBe("default");
    });
  });

  describe("long queries (5+ words)", () => {
    it("should classify a 5-word query as 'long'", () => {
      expect(classifyQuery("what is the best framework")).toBe("long");
    });

    it("should classify a longer sentence as 'long'", () => {
      expect(classifyQuery("tell me about the history of programming languages")).toBe("long");
    });

    it("should classify a verbose question as 'long'", () => {
      expect(classifyQuery("how do i configure the database connection")).toBe("long");
    });
  });

  describe("default queries (3-4 words, no entities)", () => {
    it("should classify a 3-word lowercase query as 'default'", () => {
      expect(classifyQuery("my favorite color")).toBe("default");
    });

    it("should classify a 4-word lowercase query as 'default'", () => {
      expect(classifyQuery("best practices for testing")).toBe("default");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      // Empty string splits to [""], length 1 -> "short"
      expect(classifyQuery("")).toBe("short");
    });

    it("should handle only whitespace", () => {
      // "   ".trim() = "", splits to [""], length 1 -> "short"
      expect(classifyQuery("   ")).toBe("short");
    });
  });
});

// ============================================================================
// getAdaptiveWeights()
// ============================================================================

describe("getAdaptiveWeights", () => {
  describe("with graph enabled", () => {
    it("should boost BM25 for short queries", () => {
      const [vector, bm25, graph] = getAdaptiveWeights("short", true);
      expect(bm25).toBeGreaterThan(vector);
      expect(vector).toBe(0.8);
      expect(bm25).toBe(1.2);
      expect(graph).toBe(1.0);
    });

    it("should boost graph for entity queries", () => {
      const [vector, bm25, graph] = getAdaptiveWeights("entity", true);
      expect(graph).toBeGreaterThan(vector);
      expect(graph).toBeGreaterThan(bm25);
      expect(vector).toBe(0.8);
      expect(bm25).toBe(1.0);
      expect(graph).toBe(1.3);
    });

    it("should boost vector for long queries", () => {
      const [vector, bm25, graph] = getAdaptiveWeights("long", true);
      expect(vector).toBeGreaterThan(bm25);
      expect(vector).toBeGreaterThan(graph);
      expect(vector).toBe(1.2);
      expect(bm25).toBe(0.7);
      expect(graph).toBeCloseTo(0.8);
    });

    it("should return balanced weights for default queries", () => {
      const [vector, bm25, graph] = getAdaptiveWeights("default", true);
      expect(vector).toBe(1.0);
      expect(bm25).toBe(1.0);
      expect(graph).toBe(1.0);
    });
  });

  describe("with graph disabled", () => {
    it("should zero-out graph weight for short queries", () => {
      const [vector, bm25, graph] = getAdaptiveWeights("short", false);
      expect(graph).toBe(0);
      expect(vector).toBe(0.8);
      expect(bm25).toBe(1.2);
    });

    it("should zero-out graph weight for entity queries", () => {
      const [, , graph] = getAdaptiveWeights("entity", false);
      expect(graph).toBe(0);
    });

    it("should zero-out graph weight for long queries", () => {
      const [, , graph] = getAdaptiveWeights("long", false);
      expect(graph).toBe(0);
    });

    it("should zero-out graph weight for default queries", () => {
      const [, , graph] = getAdaptiveWeights("default", false);
      expect(graph).toBe(0);
    });
  });
});

// ============================================================================
// hybridSearch() — integration test with mocked dependencies
// ============================================================================

describe("hybridSearch", () => {
  // Create mock db and embeddings
  const mockDb = {
    vectorSearch: vi.fn(),
    bm25Search: vi.fn(),
    graphSearch: vi.fn(),
    recordRetrievals: vi.fn(),
  };

  const mockEmbeddings = {
    embed: vi.fn(),
    embedBatch: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockEmbeddings.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockDb.recordRetrievals.mockResolvedValue(undefined);
  });

  function makeSignalResult(overrides: Partial<SearchSignalResult> = {}): SearchSignalResult {
    return {
      id: "mem-1",
      text: "Test memory",
      category: "fact",
      importance: 0.7,
      createdAt: "2025-01-01T00:00:00Z",
      score: 0.9,
      ...overrides,
    };
  }

  it("should return empty array when no signals return results", async () => {
    mockDb.vectorSearch.mockResolvedValue([]);
    mockDb.bm25Search.mockResolvedValue([]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
    );

    expect(results).toEqual([]);
    expect(mockDb.recordRetrievals).not.toHaveBeenCalled();
  });

  it("should fuse results from vector and BM25 signals", async () => {
    const vectorResult = makeSignalResult({ id: "mem-1", score: 0.95, text: "Vector match" });
    const bm25Result = makeSignalResult({ id: "mem-2", score: 0.8, text: "BM25 match" });

    mockDb.vectorSearch.mockResolvedValue([vectorResult]);
    mockDb.bm25Search.mockResolvedValue([bm25Result]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
    );

    expect(results.length).toBe(2);
    // Results should have scores normalized to 0-1
    expect(results[0].score).toBeLessThanOrEqual(1);
    expect(results[0].score).toBeGreaterThanOrEqual(0);
    // First result should have the highest score (normalized to 1)
    expect(results[0].score).toBe(1);
  });

  it("should deduplicate across signals (same memory in multiple signals)", async () => {
    const sharedResult = makeSignalResult({ id: "mem-shared", score: 0.9 });

    mockDb.vectorSearch.mockResolvedValue([sharedResult]);
    mockDb.bm25Search.mockResolvedValue([{ ...sharedResult, score: 0.85 }]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
    );

    // Should only have one result (deduplicated by ID)
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("mem-shared");
    // Score should be higher than either individual signal (boosted by appearing in both)
    expect(results[0].score).toBe(1); // It's the only result, so normalized to 1
  });

  it("should include graph signal when graphEnabled is true", async () => {
    mockDb.vectorSearch.mockResolvedValue([]);
    mockDb.bm25Search.mockResolvedValue([]);
    mockDb.graphSearch.mockResolvedValue([
      makeSignalResult({ id: "mem-graph", score: 0.7, text: "Graph result" }),
    ]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "tell me about Tarun",
      5,
      "agent-1",
      true,
    );

    expect(mockDb.graphSearch).toHaveBeenCalled();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("mem-graph");
  });

  it("should not call graphSearch when graphEnabled is false", async () => {
    mockDb.vectorSearch.mockResolvedValue([]);
    mockDb.bm25Search.mockResolvedValue([]);

    await hybridSearch(mockDb as never, mockEmbeddings as never, "test query", 5, "agent-1", false);

    expect(mockDb.graphSearch).not.toHaveBeenCalled();
  });

  it("should limit results to the requested count", async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) =>
      makeSignalResult({ id: `mem-${i}`, score: 0.9 - i * 0.05 }),
    );

    mockDb.vectorSearch.mockResolvedValue(manyResults);
    mockDb.bm25Search.mockResolvedValue([]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      3,
      "agent-1",
      false,
    );

    expect(results.length).toBe(3);
  });

  it("should record retrieval events for returned results", async () => {
    mockDb.vectorSearch.mockResolvedValue([
      makeSignalResult({ id: "mem-1" }),
      makeSignalResult({ id: "mem-2" }),
    ]);
    mockDb.bm25Search.mockResolvedValue([]);

    await hybridSearch(mockDb as never, mockEmbeddings as never, "test query", 5, "agent-1", false);

    expect(mockDb.recordRetrievals).toHaveBeenCalledWith(["mem-1", "mem-2"]);
  });

  it("should silently handle recordRetrievals failure", async () => {
    mockDb.vectorSearch.mockResolvedValue([makeSignalResult({ id: "mem-1" })]);
    mockDb.bm25Search.mockResolvedValue([]);
    mockDb.recordRetrievals.mockRejectedValue(new Error("DB connection lost"));

    // Should not throw
    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
    );

    expect(results.length).toBe(1);
  });

  it("should normalize scores to 0-1 range", async () => {
    mockDb.vectorSearch.mockResolvedValue([
      makeSignalResult({ id: "mem-1", score: 0.95 }),
      makeSignalResult({ id: "mem-2", score: 0.5 }),
    ]);
    mockDb.bm25Search.mockResolvedValue([]);

    const results = await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
    );

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("should use candidateMultiplier option", async () => {
    mockDb.vectorSearch.mockResolvedValue([]);
    mockDb.bm25Search.mockResolvedValue([]);

    await hybridSearch(
      mockDb as never,
      mockEmbeddings as never,
      "test query",
      5,
      "agent-1",
      false,
      { candidateMultiplier: 8 },
    );

    // limit=5, multiplier=8 => candidateLimit = 40
    expect(mockDb.vectorSearch).toHaveBeenCalledWith(expect.any(Array), 40, 0.1, "agent-1");
    expect(mockDb.bm25Search).toHaveBeenCalledWith("test query", 40, "agent-1");
  });

  it("should pass default agentId when not specified", async () => {
    mockDb.vectorSearch.mockResolvedValue([]);
    mockDb.bm25Search.mockResolvedValue([]);

    await hybridSearch(mockDb as never, mockEmbeddings as never, "test query");

    expect(mockDb.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      0.1,
      "default",
    );
  });
});
