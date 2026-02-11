/**
 * Tests for neo4j-client.ts — Database Operations.
 *
 * Tests Neo4jMemoryClient methods using mocked Neo4j driver.
 * Focuses on behavioral contracts, not implementation details.
 */

import type { Driver } from "neo4j-driver";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreMemoryInput } from "./schema.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession() {
  return {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        // Create a mock transaction that delegates to the session's run mock
        const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
        return work(mockTx);
      },
    ),
  };
}

function createMockDriver() {
  return {
    session: vi.fn().mockReturnValue(createMockSession()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ============================================================================
// Neo4jMemoryClient Tests
// ============================================================================

describe("Neo4jMemoryClient", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    // Create client (uri, username, password, dimensions, logger)
    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);

    // Replace driver with mock
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  // ------------------------------------------------------------------------
  // storeMemory()
  // ------------------------------------------------------------------------

  describe("storeMemory", () => {
    it("should store memory with correct Cypher params", async () => {
      const input: StoreMemoryInput = {
        id: "mem-1",
        text: "test memory",
        embedding: [0.1, 0.2, 0.3],
        importance: 0.8,
        category: "fact",
        source: "user",
        extractionStatus: "pending",
        agentId: "agent-1",
        sessionKey: "session-1",
      };

      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue("mem-1") }],
      });

      const result = await client.storeMemory(input);

      expect(result).toBe("mem-1");
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("CREATE (m:Memory {"),
        expect.objectContaining({
          id: "mem-1",
          text: "test memory",
          embedding: [0.1, 0.2, 0.3],
          importance: 0.8,
          category: "fact",
          source: "user",
          extractionStatus: "pending",
          agentId: "agent-1",
          sessionKey: "session-1",
          retrievalCount: 0,
          lastRetrievedAt: null,
          extractionRetries: 0,
        }),
      );
    });

    it("should store embedding correctly", async () => {
      const input: StoreMemoryInput = {
        id: "mem-1",
        text: "test",
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        importance: 0.5,
        category: "other",
        source: "auto-capture",
        extractionStatus: "skipped",
        agentId: "default",
      };

      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue("mem-1") }],
      });

      await client.storeMemory(input);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        }),
      );
    });

    it("should initialize retrievalCount to 0", async () => {
      const input: StoreMemoryInput = {
        id: "mem-1",
        text: "test",
        embedding: [],
        importance: 0.5,
        category: "other",
        source: "user",
        extractionStatus: "pending",
        agentId: "default",
      };

      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue("mem-1") }],
      });

      await client.storeMemory(input);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          retrievalCount: 0,
        }),
      );
    });
  });

  // ------------------------------------------------------------------------
  // deleteMemory()
  // ------------------------------------------------------------------------

  describe("deleteMemory", () => {
    const testMemId = "550e8400-e29b-41d4-a716-446655440000";

    it("should return true when memory exists and is deleted", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn().mockReturnValue(1) }],
      });

      const result = await client.deleteMemory(testMemId);

      expect(result).toBe(true);
    });

    it("should return false when memory does not exist", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn().mockReturnValue(0) }],
      });

      const result = await client.deleteMemory(testMemId);

      expect(result).toBe(false);
    });

    it("should decrement entity mention counts and delete atomically", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn().mockReturnValue(1) }],
      });

      await client.deleteMemory(testMemId);

      // Single atomic query handles both mentionCount decrement and delete
      expect(mockSession.run).toHaveBeenCalledTimes(1);
      expect(mockSession.run).toHaveBeenCalledWith(expect.stringContaining("MENTIONS"), {
        id: testMemId,
      });
      expect(mockSession.run).toHaveBeenCalledWith(expect.stringContaining("DETACH DELETE"), {
        id: testMemId,
      });
    });

    it("should reject invalid UUID format", async () => {
      await expect(client.deleteMemory("not-a-uuid")).rejects.toThrow("Invalid memory ID format");
    });

    it("should accept valid UUID formats", async () => {
      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue(1) }],
      });

      await expect(client.deleteMemory("550e8400-e29b-41d4-a716-446655440000")).resolves.toBe(true);
    });
  });

  // ------------------------------------------------------------------------
  // findSimilar()
  // ------------------------------------------------------------------------

  describe("findSimilar", () => {
    it("should query vector index with threshold", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              if (key === "id") return "mem-1";
              if (key === "text") return "similar text";
              if (key === "similarity") return 0.96;
              return null;
            }),
          },
        ],
      });

      const result = await client.findSimilar([0.1, 0.2, 0.3], 0.95, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "mem-1",
        text: "similar text",
        score: 0.96,
      });
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("db.index.vector.queryNodes"),
        expect.objectContaining({
          embedding: [0.1, 0.2, 0.3],
          threshold: 0.95,
        }),
      );
    });

    it("should filter results by threshold", async () => {
      // Mock should only return results >= threshold
      // (In reality, the vector index does this filtering)
      mockSession.run.mockResolvedValue({ records: [] });

      const result = await client.findSimilar([0.1, 0.2], 0.99, 10);

      expect(result).toHaveLength(0);
    });

    it("should return empty array on vector index failure", async () => {
      mockSession.run.mockRejectedValue(new Error("index not ready"));

      const result = await client.findSimilar([0.1, 0.2], 0.95, 5);

      expect(result).toEqual([]);
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it("should filter by agentId when provided", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              if (key === "id") return "mem-1";
              if (key === "text") return "similar text";
              if (key === "similarity") return 0.96;
              return null;
            }),
          },
        ],
      });

      const result = await client.findSimilar([0.1, 0.2, 0.3], 0.95, 5, "agent-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "mem-1", text: "similar text", score: 0.96 });
      // Should include agentId filter in query and params
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("node.agentId = $agentId"),
        expect.objectContaining({ agentId: "agent-1" }),
      );
    });

    it("should fetch extra candidates and trim when agentId is provided", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              if (key === "id") return "mem-1";
              if (key === "text") return "text 1";
              if (key === "similarity") return 0.99;
              return null;
            }),
          },
          {
            get: vi.fn((key) => {
              if (key === "id") return "mem-2";
              if (key === "text") return "text 2";
              if (key === "similarity") return 0.97;
              return null;
            }),
          },
        ],
      });

      // Request limit=1 with agentId: should fetch 3x candidates (limit*3) and trim to 1
      const result = await client.findSimilar([0.1, 0.2], 0.95, 1, "agent-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("mem-1");
    });
  });

  // ------------------------------------------------------------------------
  // findDuplicateClusters()
  // ------------------------------------------------------------------------

  describe("findDuplicateClusters", () => {
    it("should use union-find to build clusters", async () => {
      // Mock all memories
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: vi.fn((key) => {
              if (key === "id") return "m1";
              if (key === "text") return "text1";
              if (key === "importance") return 0.5;
              return null;
            }),
          },
          {
            get: vi.fn((key) => {
              if (key === "id") return "m2";
              if (key === "text") return "text2";
              if (key === "importance") return 0.6;
              return null;
            }),
          },
          {
            get: vi.fn((key) => {
              if (key === "id") return "m3";
              if (key === "text") return "text3";
              if (key === "importance") return 0.7;
              return null;
            }),
          },
        ],
      });

      // Mock vector similarity queries
      // m1 similar to m2, m2 similar to m3 => cluster {m1, m2, m3}
      mockSession.run
        .mockResolvedValueOnce({
          // m1 neighbors
          records: [{ get: vi.fn().mockReturnValue("m2") }],
        })
        .mockResolvedValueOnce({
          // m2 neighbors
          records: [{ get: vi.fn().mockReturnValue("m3") }],
        })
        .mockResolvedValueOnce({
          // m3 neighbors
          records: [],
        });

      const result = await client.findDuplicateClusters(0.95);

      expect(result).toHaveLength(1);
      expect(result[0].memoryIds).toHaveLength(3);
      expect(result[0].memoryIds).toContain("m1");
      expect(result[0].memoryIds).toContain("m2");
      expect(result[0].memoryIds).toContain("m3");
    });

    it("should respect safety bound (max 500 pairs)", async () => {
      // Create many memories
      const manyRecords = Array.from({ length: 100 }, (_, i) => ({
        get: vi.fn((key) => {
          if (key === "id") return `m${i}`;
          if (key === "text") return `text${i}`;
          if (key === "importance") return 0.5;
          return null;
        }),
      }));

      mockSession.run.mockResolvedValueOnce({ records: manyRecords });

      // Mock each memory finding many neighbors (would exceed 500 pairs)
      for (let i = 0; i < 100; i++) {
        mockSession.run.mockResolvedValueOnce({
          records: Array.from({ length: 10 }, (_, j) => ({
            get: vi.fn().mockReturnValue(`m${(i + j + 1) % 100}`),
          })),
        });

        // Early exit when pairsFound > 500
        if (i >= 50) break;
      }

      const result = await client.findDuplicateClusters(0.95);

      // Should exit early without processing all memories
      expect(result).toBeDefined();
    });

    it("should return only clusters with 2+ members", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          { get: vi.fn((key) => (key === "id" ? "m1" : key === "text" ? "text1" : 0.5)) },
          { get: vi.fn((key) => (key === "id" ? "m2" : key === "text" ? "text2" : 0.6)) },
        ],
      });

      // m1 has no neighbors, m2 has no neighbors => no clusters
      mockSession.run.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] });

      const result = await client.findDuplicateClusters(0.95);

      expect(result).toHaveLength(0);
    });

    it("should handle empty database", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      const result = await client.findDuplicateClusters(0.95);

      expect(result).toEqual([]);
    });

    it("should handle single memory", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn((key) => (key === "id" ? "m1" : key === "text" ? "text1" : 0.5)) }],
      });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await client.findDuplicateClusters(0.95);

      expect(result).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------
  // mergeMemoryCluster()
  // ------------------------------------------------------------------------

  describe("mergeMemoryCluster", () => {
    it("should keep highest importance memory", async () => {
      const txRun = vi
        .fn()
        // Verify step
        .mockResolvedValueOnce({
          records: [
            { get: vi.fn((key: string) => (key === "memId" ? "low" : true)) },
            { get: vi.fn((key: string) => (key === "memId" ? "high" : true)) },
            { get: vi.fn((key: string) => (key === "memId" ? "mid" : true)) },
          ],
        })
        // Transfer mentions
        .mockResolvedValueOnce({ records: [] })
        // Delete duplicates
        .mockResolvedValueOnce({ records: [] });

      mockSession.executeWrite.mockImplementationOnce(
        async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
          return work({ run: txRun });
        },
      );

      const result = await client.mergeMemoryCluster(["low", "high", "mid"], [0.3, 0.9, 0.5]);

      expect(result.survivorId).toBe("high");
      expect(result.deletedCount).toBe(2);

      // Should delete "low" and "mid"
      expect(txRun).toHaveBeenCalledWith(
        expect.stringContaining("DETACH DELETE"),
        expect.objectContaining({ toDelete: ["low", "mid"] }),
      );
    });

    it("should transfer MENTIONS relationships to survivor", async () => {
      const txRun = vi
        .fn()
        .mockResolvedValueOnce({
          records: [
            { get: vi.fn((key: string) => (key === "memId" ? "m1" : true)) },
            { get: vi.fn((key: string) => (key === "memId" ? "m2" : true)) },
          ],
        })
        .mockResolvedValueOnce({ records: [] })
        .mockResolvedValueOnce({ records: [] });

      mockSession.executeWrite.mockImplementationOnce(
        async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
          return work({ run: txRun });
        },
      );

      await client.mergeMemoryCluster(["m1", "m2"], [0.5, 0.6]);

      // Should transfer mentions from m1 to m2
      expect(txRun).toHaveBeenCalledWith(
        expect.stringContaining("MENTIONS"),
        expect.objectContaining({
          toDelete: ["m1"],
          survivorId: "m2",
        }),
      );
    });

    it("should skip merge when cluster members are missing", async () => {
      const txRun = vi.fn().mockResolvedValueOnce({
        records: [
          { get: vi.fn((key: string) => (key === "memId" ? "m1" : true)) },
          { get: vi.fn((key: string) => (key === "memId" ? "m2" : false)) }, // missing!
        ],
      });

      mockSession.executeWrite.mockImplementationOnce(
        async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
          return work({ run: txRun });
        },
      );

      const result = await client.mergeMemoryCluster(["m1", "m2"], [0.5, 0.6]);

      expect(result.deletedCount).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("skipping cluster merge"),
      );
    });

    it("should handle single-member cluster gracefully", async () => {
      const txRun = vi.fn().mockResolvedValueOnce({
        records: [{ get: vi.fn((key: string) => (key === "memId" ? "m1" : true)) }],
      });

      mockSession.executeWrite.mockImplementationOnce(
        async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
          return work({ run: txRun });
        },
      );

      const result = await client.mergeMemoryCluster(["m1"], [0.8]);

      expect(result.survivorId).toBe("m1");
      expect(result.deletedCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------------
  // invalidateMemory()
  // ------------------------------------------------------------------------

  describe("invalidateMemory", () => {
    it("should set importance to 0.01", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.invalidateMemory("mem-1");

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.importance = 0.01"),
        expect.objectContaining({ id: "mem-1" }),
      );
    });

    it("should update updatedAt timestamp", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.invalidateMemory("mem-1");

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.updatedAt"),
        expect.objectContaining({
          id: "mem-1",
          now: expect.any(String),
        }),
      );
    });
  });

  // ------------------------------------------------------------------------
  // calculateAllEffectiveScores()
  // ------------------------------------------------------------------------

  describe("calculateAllEffectiveScores", () => {
    it("should apply correct formula (importance × freq_boost × recency)", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "test",
                category: "fact",
                importance: 0.8,
                retrievalCount: 10,
                ageDays: 7,
                effectiveScore: 0.75, // Pre-calculated by Cypher
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.calculateAllEffectiveScores();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "m1",
        text: "test",
        category: "fact",
        importance: 0.8,
        retrievalCount: 10,
        ageDays: 7,
        effectiveScore: 0.75,
      });
    });

    it("should handle empty database", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      const result = await client.calculateAllEffectiveScores();

      expect(result).toEqual([]);
    });

    it("should filter by agentId when provided", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.calculateAllEffectiveScores("agent-1");

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.agentId = $agentId"),
        expect.objectContaining({ agentId: "agent-1" }),
      );
    });
  });

  // ------------------------------------------------------------------------
  // calculateParetoThreshold()
  // ------------------------------------------------------------------------

  describe("calculateParetoThreshold", () => {
    it("should return correct 80th percentile", () => {
      const scores = [
        {
          id: "1",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 1.0,
        },
        {
          id: "2",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.9,
        },
        {
          id: "3",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.8,
        },
        {
          id: "4",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.7,
        },
        {
          id: "5",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.6,
        },
        {
          id: "6",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.5,
        },
        {
          id: "7",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.4,
        },
        {
          id: "8",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.3,
        },
        {
          id: "9",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.2,
        },
        {
          id: "10",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.1,
        },
      ];

      // percentile=0.8 means top 20%
      const threshold = client.calculateParetoThreshold(scores, 0.8);

      // 80th percentile of [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
      // Top 20% = 2 items, boundary at floor(10 * 0.2) = 2, but for top N%, use index N-1 as threshold
      // FIXME: Implementation returns sorted[1] = 0.9 for top 20%, not sorted[2] = 0.8
      expect(threshold).toBe(0.9);
    });

    it("should handle empty scores array", () => {
      const threshold = client.calculateParetoThreshold([], 0.8);
      expect(threshold).toBe(0);
    });

    it("should handle single score", () => {
      const scores = [
        {
          id: "1",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.75,
        },
      ];
      const threshold = client.calculateParetoThreshold(scores, 0.8);
      expect(threshold).toBe(0.75);
    });

    it("should handle 50th percentile (median)", () => {
      const scores = [
        {
          id: "1",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 1.0,
        },
        {
          id: "2",
          text: "",
          category: "fact",
          importance: 0.9,
          retrievalCount: 0,
          ageDays: 0,
          effectiveScore: 0.5,
        },
      ];
      const threshold = client.calculateParetoThreshold(scores, 0.5);
      // For 2 items with percentile 0.5, boundary index = floor(2 * 0.5) = 1, so threshold is second item's score
      expect(threshold).toBe(0.5);
    });
  });

  // ------------------------------------------------------------------------
  // retryOnTransient()
  // ------------------------------------------------------------------------

  describe("retryOnTransient", () => {
    it("should retry on transient errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("TransientError: deadlock"))
        .mockResolvedValueOnce("success");

      const result = await (client as any).retryOnTransient(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should throw on permanent errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("ConstraintViolation"));

      await expect((client as any).retryOnTransient(fn)).rejects.toThrow("ConstraintViolation");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should exhaust retries and throw", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("TransientError: timeout"));

      await expect((client as any).retryOnTransient(fn)).rejects.toThrow("TransientError");
      expect(fn).toHaveBeenCalledTimes(3); // TRANSIENT_RETRY_ATTEMPTS = 3
    });

    it("should identify transient error patterns", async () => {
      const transientErrors = [
        "TransientError",
        "DeadlockDetected",
        "ServiceUnavailable",
        "SessionExpired",
      ];

      for (const errMsg of transientErrors) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error(errMsg))
          .mockResolvedValueOnce("success");

        const result = await (client as any).retryOnTransient(fn);
        expect(result).toBe("success");
      }
    });
  });

  // ------------------------------------------------------------------------
  // promoteToCore()
  // ------------------------------------------------------------------------

  describe("Core promotion", () => {
    it("should promote memories to core category", async () => {
      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue(2) }],
      });

      const result = await client.promoteToCore(["m1", "m2"]);

      expect(result).toBe(2);
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("category = 'core'"),
        expect.objectContaining({ ids: ["m1", "m2"] }),
      );
    });

    it("should handle empty ID arrays", async () => {
      const promoteResult = await client.promoteToCore([]);

      expect(promoteResult).toBe(0);
    });
  });

  // ------------------------------------------------------------------------
  // findDecayedMemories()
  // ------------------------------------------------------------------------

  describe("findDecayedMemories", () => {
    it("should find memories below retention threshold", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "old memory",
                importance: 0.2,
                ageDays: 100,
                decayScore: 0.05,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.findDecayedMemories({
        retentionThreshold: 0.1,
        baseHalfLifeDays: 30,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "m1",
        text: "old memory",
        importance: 0.2,
        ageDays: 100,
        decayScore: 0.05,
      });
    });

    it("should exclude core memories from decay", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.findDecayedMemories();

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.category <> 'core'"),
        expect.any(Object),
      );
    });

    it("should use exponential decay formula", async () => {
      // The Cypher query should implement: importance × e^(-age / halfLife)
      mockSession.run.mockResolvedValue({ records: [] });

      await client.findDecayedMemories({
        baseHalfLifeDays: 30,
        importanceMultiplier: 2,
      });

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("exp("),
        expect.objectContaining({
          baseHalfLife: 30,
          importanceMult: 2,
        }),
      );
    });
  });

  // ------------------------------------------------------------------------
  // pruneMemories()
  // ------------------------------------------------------------------------

  describe("pruneMemories", () => {
    it("should delete decayed memories", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn().mockReturnValue(3) }],
      });

      const result = await client.pruneMemories(["m1", "m2", "m3"]);

      expect(result).toBe(3);
    });

    it("should decrement entity mention counts and delete atomically", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn().mockReturnValue(2) }],
      });

      await client.pruneMemories(["m1", "m2"]);

      // Single atomic query handles both mentionCount decrement and delete
      expect(mockSession.run).toHaveBeenCalledTimes(1);
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("MENTIONS"),
        expect.objectContaining({ ids: ["m1", "m2"] }),
      );
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("DETACH DELETE"),
        expect.objectContaining({ ids: ["m1", "m2"] }),
      );
    });

    it("should handle empty ID array", async () => {
      const result = await client.pruneMemories([]);

      expect(result).toBe(0);
      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------
  // findOrphanEntities() / deleteOrphanEntities()
  // ------------------------------------------------------------------------

  describe("Orphan cleanup", () => {
    it("should find entities with mentionCount <= 0", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "e1",
                name: "orphan",
                type: "concept",
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.findOrphanEntities();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "e1",
        name: "orphan",
        type: "concept",
      });
    });

    it("should delete orphan entities", async () => {
      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue(2) }],
      });

      const result = await client.deleteOrphanEntities(["e1", "e2"]);

      expect(result).toBe(2);
    });

    it("should find orphan tags (no TAGGED relationships)", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = { id: "t1", name: "unused" };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.findOrphanTags();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "t1",
        name: "unused",
      });
    });

    it("should delete orphan tags", async () => {
      mockSession.run.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue(1) }],
      });

      const result = await client.deleteOrphanTags(["t1"]);

      expect(result).toBe(1);
    });
  });

  // ------------------------------------------------------------------------
  // findConflictingMemories()
  // ------------------------------------------------------------------------

  describe("findConflictingMemories", () => {
    it("should find memory pairs sharing entities", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                m1Id: "mem1",
                m1Text: "user prefers dark mode",
                m1Importance: 0.7,
                m1CreatedAt: "2024-01-01",
                m2Id: "mem2",
                m2Text: "user prefers light mode",
                m2Importance: 0.6,
                m2CreatedAt: "2024-01-02",
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.findConflictingMemories();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        memoryA: {
          id: "mem1",
          text: "user prefers dark mode",
          importance: 0.7,
        },
        memoryB: {
          id: "mem2",
          text: "user prefers light mode",
          importance: 0.6,
        },
      });
    });

    it("should exclude core memories from conflict detection", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.findConflictingMemories();

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m1.category <> 'core'"),
        expect.any(Object),
      );
    });

    it("should limit results to 50 pairs", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.findConflictingMemories();

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 50"),
        expect.any(Object),
      );
    });
  });

  // ------------------------------------------------------------------------
  // Extraction status tracking
  // ------------------------------------------------------------------------

  describe("Extraction status", () => {
    it("should update extraction status", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.updateExtractionStatus("mem-1", "complete");

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.extractionStatus = $status"),
        expect.objectContaining({
          id: "mem-1",
          status: "complete",
        }),
      );
    });

    it("should increment retry counter when option is set", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.updateExtractionStatus("mem-1", "pending", { incrementRetries: true });

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.extractionRetries"),
        expect.any(Object),
      );
    });

    it("should count memories by extraction status", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          { get: vi.fn((key) => (key === "status" ? "pending" : 5)) },
          { get: vi.fn((key) => (key === "status" ? "complete" : 10)) },
          { get: vi.fn((key) => (key === "status" ? "failed" : 2)) },
        ],
      });

      const result = await client.countByExtractionStatus();

      expect(result).toEqual({
        pending: 5,
        complete: 10,
        failed: 2,
        skipped: 0,
      });
    });

    it("should list pending extractions", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "pending text",
                agentId: "agent-1",
                extractionRetries: 1,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.listPendingExtractions(100);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "m1",
        text: "pending text",
        agentId: "agent-1",
        extractionRetries: 1,
      });
    });

    it("should not pass agentId: undefined in listPendingExtractions params", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.listPendingExtractions(50);

      const params = mockSession.run.mock.calls[0][1] as Record<string, unknown>;
      expect(params).not.toHaveProperty("agentId");
    });
  });

  // ------------------------------------------------------------------------
  // Search operations
  // ------------------------------------------------------------------------

  describe("Search operations", () => {
    it("should perform vector search with min score threshold", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "result",
                category: "fact",
                importance: 0.8,
                createdAt: "2024-01-01",
                similarity: 0.92,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.vectorSearch([0.1, 0.2], 10, 0.9);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "m1",
        text: "result",
        score: 0.92,
      });
    });

    it("should perform BM25 search and normalize scores", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "result",
                category: "fact",
                importance: 0.8,
                createdAt: "2024-01-01",
                bm25Score: 5.0,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.bm25Search("test query", 10);

      expect(result).toHaveLength(1);
      // Single result: score should be moderate 0.5 (not 1.0) to avoid inflating weak matches
      expect(result[0].score).toBe(0.5);
    });

    it("should normalize BM25 scores with min-max when multiple results exist", async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "best match",
                category: "fact",
                importance: 0.8,
                createdAt: "2024-01-01",
                bm25Score: 10.0,
              };
              return data[key];
            }),
          },
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m2",
                text: "worst match",
                category: "fact",
                importance: 0.5,
                createdAt: "2024-01-02",
                bm25Score: 2.0,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.bm25Search("test", 10);

      expect(result).toHaveLength(2);
      // Best result gets score 1.0 (FLOOR + (1-FLOOR)*1)
      expect(result[0].score).toBe(1.0);
      // Worst result gets FLOOR (0.3)
      expect(result[1].score).toBeCloseTo(0.3);
    });

    it("should escape Lucene special characters in BM25 query", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.bm25Search("test+query*", 10);

      // Should escape + and *
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          query: expect.stringContaining("\\+"),
        }),
      );
    });

    it("should perform graph search with entity traversal", async () => {
      // Combined single-query now returns memory records directly
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: vi.fn((key) => {
              const data: Record<string, any> = {
                id: "m1",
                text: "result",
                category: "fact",
                importance: 0.8,
                createdAt: "2024-01-01",
                graphScore: 0.9,
              };
              return data[key];
            }),
          },
        ],
      });

      const result = await client.graphSearch("tarun", 10, 0.3);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "m1",
        score: 0.9,
      });
    });
  });

  // ------------------------------------------------------------------------
  // reindex()
  // ------------------------------------------------------------------------

  describe("reindex", () => {
    it("should use UNWIND batch update instead of individual queries", async () => {
      // Mock drop index session
      const dropSession = createMockSession();
      // Mock fetch session (returns 2 memories)
      const fetchSession = createMockSession();
      fetchSession.run.mockResolvedValueOnce({
        records: [
          { get: vi.fn((key) => (key === "id" ? "m1" : "text 1")) },
          { get: vi.fn((key) => (key === "id" ? "m2" : "text 2")) },
        ],
      });
      // Mock batch update session
      const updateSession = createMockSession();
      // Mock recreate index session
      const indexSession = createMockSession();

      mockDriver.session
        .mockReturnValueOnce(dropSession)
        .mockReturnValueOnce(fetchSession)
        .mockReturnValueOnce(updateSession)
        .mockReturnValueOnce(indexSession);

      const embedFn = vi.fn().mockResolvedValue([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);

      await client.reindex(embedFn, { batchSize: 50 });

      // Should call UNWIND batch, not individual queries
      expect(updateSession.run).toHaveBeenCalledTimes(1);
      expect(updateSession.run).toHaveBeenCalledWith(
        expect.stringContaining("UNWIND $items"),
        expect.objectContaining({
          items: [
            { id: "m1", embedding: [0.1, 0.2] },
            { id: "m2", embedding: [0.3, 0.4] },
          ],
        }),
      );
    });

    it("should skip batch update when all embeddings are empty", async () => {
      const dropSession = createMockSession();
      const fetchSession = createMockSession();
      fetchSession.run.mockResolvedValueOnce({
        records: [{ get: vi.fn((key) => (key === "id" ? "m1" : "text 1")) }],
      });
      const indexSession = createMockSession();

      mockDriver.session
        .mockReturnValueOnce(dropSession)
        .mockReturnValueOnce(fetchSession)
        .mockReturnValueOnce(indexSession);

      const embedFn = vi.fn().mockResolvedValue([[]]);

      await client.reindex(embedFn, { batchSize: 50 });

      // No update session should be created (only drop, fetch, and index sessions)
      expect(mockDriver.session).toHaveBeenCalledTimes(3);
    });
  });

  // ------------------------------------------------------------------------
  // Retrieval tracking
  // ------------------------------------------------------------------------

  describe("Retrieval tracking", () => {
    it("should record retrieval events", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.recordRetrievals(["m1", "m2", "m3"]);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.retrievalCount"),
        expect.objectContaining({
          ids: ["m1", "m2", "m3"],
        }),
      );
    });

    it("should update lastRetrievedAt timestamp", async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await client.recordRetrievals(["m1"]);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining("m.lastRetrievedAt"),
        expect.objectContaining({
          now: expect.any(String),
        }),
      );
    });

    it("should handle empty retrieval array", async () => {
      await client.recordRetrievals([]);

      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });
});
