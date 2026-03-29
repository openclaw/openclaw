import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryDB } from "./database.js";
import { DreamService } from "./dream.js";
import { GraphDB } from "./graph.js";

// Mock dependencies for DreamService
const mockApi = {
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
};

const mockTracer = {
  traceRecall: vi.fn(),
  traceStore: vi.fn(),
  traceSummary: vi.fn(),
  traceGraph: vi.fn(),
  traceError: vi.fn(),
  trace: vi.fn(),
} as any;

vi.mock("./consolidate.js", () => ({
  clusterBySimilarity: vi.fn(),
  mergeFacts: vi.fn(),
  mergeFactsBatch: vi.fn().mockResolvedValue([]),
}));

import { clusterBySimilarity, mergeFactsBatch } from "./consolidate.js";

describe("P1 Bug Reproduction", () => {
  describe("Bug 1: DreamService Async Crash", () => {
    test("should throw because findEdgesForTexts is not awaited", async () => {
      const mockDb = {
        cleanupTrash: vi.fn().mockResolvedValue(0),
        getMemoriesByCategory: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([
          { id: "1", text: "fact 1", category: "fact" },
          { id: "2", text: "fact 2", category: "fact" },
          { id: "3", text: "fact 3", category: "fact" },
          { id: "4", text: "fact 4", category: "fact" },
          { id: "5", text: "fact 5", category: "fact" },
        ]),
      } as any;
      const mockChat = { complete: vi.fn() } as any;
      const mockEmbeddings = { embedBatch: vi.fn() } as any;
      const mockGraph = {
        // BUG REPRO: This is async, but dream.ts calls it synchronously
        findEdgesForTexts: vi.fn().mockImplementation(async () => []),
        compact: vi.fn(),
      } as any;

      const dreamService = new DreamService(
        mockApi as any,
        mockDb,
        mockEmbeddings,
        mockGraph,
        mockChat,
        mockTracer,
      );

      // Mock clusterer to trigger the problematic path
      (clusterBySimilarity as any).mockReturnValue([
        [
          { id: "1", text: "fact 1", category: "fact" },
          { id: "2", text: "fact 2", category: "fact" },
        ],
      ]);

      // This should NOT throw if fixed
      await (dreamService as any).consolidateKnowledge();
      console.log("🟢 Bug 1 Verified: resolve findEdgesForTexts properly");
    });
  });

  describe("Bug 2 & 3: MemoryDB Recall Flush Issues", () => {
    let db: MemoryDB;
    let mockTable: any;

    beforeEach(() => {
      db = new MemoryDB("/tmp/test-db", 384, mockTracer, mockApi.logger as any);
      mockTable = {
        query: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
        add: vi.fn().mockResolvedValue(true),
        update: vi.fn().mockResolvedValue(true),
        createIndex: vi.fn().mockResolvedValue(true),
      };
      (db as any).table = mockTable;
      (db as any).availableColumns = new Set(["id", "recallCount", "text"]);
    });

    test("Bug 2: Flush double-counts if new recalls happen during flush", async () => {
      const id = "12345678-1234-1234-1234-123456789012";
      db.incrementRecallCount([id]); // delta = 1

      const existingRow = { id, recallCount: 10, text: "hello" };
      mockTable.toArray.mockResolvedValue([existingRow]);

      // Simulate a new recall happening right after we fetch existing rows but before we calculate updatedRow
      // In the current code:
      // const existingRows = await this.getByIds(ids); // points to our mock fetch
      // --- RECALL HAPPENS HERE ---
      // for (const row of existingRows) { const delta = this.recallCountDeltas.get(id) ?? 0; ... }

      const originalGet = db.getByIds.bind(db);
      db.getByIds = async (ids: string[]) => {
        const rows = await originalGet(ids);
        db.incrementRecallCount([id]); // delta becomes 2
        return rows;
      };

      await db.flushRecallCounts();

      // Bug 2 Verified:
      // 1. We had 1 recall at start.
      // 2. 1 more happened during flush.
      // 3. 1 was persisted to DB.
      // 4. 1 should remain in the map.
      expect(db.pendingRecallFlushCount).toBe(1);
      console.log("🟢 Bug 2 Verified: Recall delta correctly tracked without inflation");
    });

    test("Bug 3: Stable ID update (Atomic persistence)", async () => {
      const id = "12345678-1234-1234-1234-123456789012";
      db.incrementRecallCount([id]);

      mockTable.toArray.mockResolvedValue([{ id, recallCount: 10, text: "hello" }]);
      mockTable.update = vi.fn().mockResolvedValue(true);

      const flushed = await db.flushRecallCounts();

      expect(flushed).toBe(1);
      expect(mockTable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: `id = '${id}'`,
          values: { recallCount: 11 },
        }),
      );
      console.log("🟢 Bug 3 Verified: Stable update replaces the dangerous delete-swap hack");
    });
  });
});
