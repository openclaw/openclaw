/**
 * Tests for entity deduplication in neo4j-client.ts.
 *
 * Tests findDuplicateEntityPairs() and mergeEntityPair() using mocked Neo4j driver.
 * Verifies substring-matching logic, mention-count based decisions, and merge behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

// ============================================================================
// Entity Deduplication Tests
// ============================================================================

describe("Entity Deduplication", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  // --------------------------------------------------------------------------
  // findDuplicateEntityPairs()
  // --------------------------------------------------------------------------

  describe("findDuplicateEntityPairs", () => {
    it("finds substring matches: 'tarun' + 'tarun sukhani' (same type)", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "tarun",
            mc1: 5,
            id2: "e2",
            name2: "tarun sukhani",
            mc2: 3,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // "tarun" has more mentions (5 > 3), so it should be kept
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("tarun");
      expect(pairs[0].removeId).toBe("e2");
      expect(pairs[0].removeName).toBe("tarun sukhani");
    });

    it("keeps entity with more mentions regardless of name length", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "fish speech",
            mc1: 2,
            id2: "e2",
            name2: "fish speech s1 mini",
            mc2: 10,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // "fish speech s1 mini" has more mentions (10 > 2), so it should be kept
      expect(pairs[0].keepId).toBe("e2");
      expect(pairs[0].keepName).toBe("fish speech s1 mini");
      expect(pairs[0].removeId).toBe("e1");
      expect(pairs[0].removeName).toBe("fish speech");
    });

    it("keeps shorter name when mentions are equal", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "aaditya",
            mc1: 5,
            id2: "e2",
            name2: "aaditya sukhani",
            mc2: 5,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // Equal mentions, so keep the shorter name ("aaditya")
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("aaditya");
      expect(pairs[0].removeId).toBe("e2");
      expect(pairs[0].removeName).toBe("aaditya sukhani");
    });

    it("returns empty array when no duplicates exist", async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(0);
    });

    it("handles multiple duplicate pairs", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "tarun",
            mc1: 5,
            id2: "e2",
            name2: "tarun sukhani",
            mc2: 3,
          }),
          mockRecord({
            id1: "e3",
            name1: "fish speech",
            mc1: 2,
            id2: "e4",
            name2: "fish speech s1 mini",
            mc2: 8,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(2);
    });

    it("handles NULL mention counts (treats as 0)", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "neo4j",
            mc1: null,
            id2: "e2",
            name2: "neo4j database",
            mc2: null,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // Both NULL (treated as 0), so keep the shorter name
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("neo4j");
    });

    it("passes the Cypher query with substring matching and type constraint", async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await client.findDuplicateEntityPairs();

      const query = mockSession.run.mock.calls[0][0] as string;
      // Verify the query checks same type
      expect(query).toContain("e1.type = e2.type");
      // Verify the query checks CONTAINS in both directions
      expect(query).toContain("e1.name CONTAINS e2.name");
      expect(query).toContain("e2.name CONTAINS e1.name");
      // Verify minimum name length filter
      expect(query).toContain("size(e1.name) > 2");
    });
  });

  // --------------------------------------------------------------------------
  // mergeEntityPair()
  // --------------------------------------------------------------------------

  describe("mergeEntityPair", () => {
    it("transfers MENTIONS and deletes source entity", async () => {
      // mergeEntityPair uses executeWrite, so we need to set up the mock transaction
      const mockTx = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            // Transfer MENTIONS
            records: [mockRecord({ transferred: 3 })],
          })
          .mockResolvedValueOnce({
            // Update mentionCount
            records: [],
          })
          .mockResolvedValueOnce({
            // Delete removed entity
            records: [],
          }),
      };

      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      const result = await client.mergeEntityPair("keep-id", "remove-id");

      expect(result).toBe(true);
      // Should have been called 3 times: transfer, update count, delete
      expect(mockTx.run).toHaveBeenCalledTimes(3);

      // Verify transfer query
      const transferQuery = mockTx.run.mock.calls[0][0] as string;
      expect(transferQuery).toContain("MERGE (m)-[:MENTIONS]->(keep)");
      expect(transferQuery).toContain("DELETE r");

      // Verify update mentionCount
      const updateQuery = mockTx.run.mock.calls[1][0] as string;
      expect(updateQuery).toContain("mentionCount");

      // Verify delete query
      const deleteQuery = mockTx.run.mock.calls[2][0] as string;
      expect(deleteQuery).toContain("DETACH DELETE e");
    });

    it("skips mentionCount update when no relationships to transfer", async () => {
      const mockTx = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            // Transfer MENTIONS — 0 transferred
            records: [mockRecord({ transferred: 0 })],
          })
          .mockResolvedValueOnce({
            // Delete removed entity (mentionCount update is skipped)
            records: [],
          }),
      };

      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      const result = await client.mergeEntityPair("keep-id", "remove-id");

      expect(result).toBe(true);
      // Only 2 calls: transfer (0 results) and delete (skip update)
      expect(mockTx.run).toHaveBeenCalledTimes(2);
    });

    it("returns false on error", async () => {
      mockSession.executeWrite.mockRejectedValueOnce(new Error("Neo4j connection lost"));

      const result = await client.mergeEntityPair("keep-id", "remove-id");

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // reconcileEntityMentionCounts()
  // --------------------------------------------------------------------------

  describe("reconcileEntityMentionCounts", () => {
    it("updates entities with NULL mentionCount", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [mockRecord({ updated: 42 })],
      });

      const updated = await client.reconcileEntityMentionCounts();

      expect(updated).toBe(42);
      const query = mockSession.run.mock.calls[0][0] as string;
      expect(query).toContain("mentionCount IS NULL");
      expect(query).toContain("SET e.mentionCount = actual");
    });

    it("returns 0 when all entities have mentionCount set", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [mockRecord({ updated: 0 })],
      });

      const updated = await client.reconcileEntityMentionCounts();

      expect(updated).toBe(0);
    });
  });
});
