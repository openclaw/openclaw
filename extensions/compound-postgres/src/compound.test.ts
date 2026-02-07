import { describe, it, expect, vi, beforeEach } from "vitest";

// ── parseLearningFromArgs is not exported, so we test via the command handler
// We'll test the compound module's exported functions with mocked pg

// Mock pg pool
function createMockPool() {
  return {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
  };
}

describe("compound learnings", () => {
  describe("insertLearning", () => {
    let mockPool: ReturnType<typeof createMockPool>;

    beforeEach(() => {
      mockPool = createMockPool();
    });

    it("should insert a learning with all fields", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });

      const { insertLearning } = await import("./compound.js");
      const id = await insertLearning(mockPool as never, {
        sessionKey: "sess-123",
        sessionId: "id-456",
        category: "bug-fix",
        title: "Fix race condition in queue",
        problem: "Events processed out of order",
        solution: "Add mutex lock on dequeue",
        tags: ["concurrency", "queue"],
      });

      expect(id).toBe(42);
      expect(mockPool.query).toHaveBeenCalledOnce();

      const [sql, params] = mockPool.query.mock.calls.at(0) as [string, unknown[]];
      expect(sql).toContain("INSERT INTO compound_learnings");
      expect(params).toEqual([
        "sess-123",
        "id-456",
        "bug-fix",
        "Fix race condition in queue",
        "Events processed out of order",
        "Add mutex lock on dequeue",
        ["concurrency", "queue"],
        null,
      ]);
    });

    it("should handle minimal learning (only required fields)", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const { insertLearning } = await import("./compound.js");
      const id = await insertLearning(mockPool as never, {
        category: "general",
        title: "Test learning",
        tags: [],
      });

      expect(id).toBe(1);
      const params = (mockPool.query.mock.calls.at(0) as [string, unknown[]])[1];
      expect(params.at(0)).toBeNull(); // sessionKey
      expect(params.at(1)).toBeNull(); // sessionId
    });
  });

  describe("fetchRecentLearnings", () => {
    it("should query with relevance-weighted ordering", async () => {
      const mockPool = createMockPool();
      const mockRows = [
        {
          id: 1,
          category: "pattern",
          title: "Use pool connections",
          problem: null,
          solution: "Always release clients",
          tags: ["pg"],
          ts: new Date(),
          relevance_score: 1.0,
        },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: mockRows });

      const { fetchRecentLearnings } = await import("./compound.js");
      const learnings = await fetchRecentLearnings(mockPool as never, 3);

      expect(learnings).toEqual(mockRows);
      const [sql, params] = mockPool.query.mock.calls.at(0) as [string, unknown[]];
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("relevance_score");
      expect(params).toEqual([3]);
    });
  });

  describe("markInjected", () => {
    it("should update times_injected for given ids", async () => {
      const mockPool = createMockPool();
      mockPool.query.mockResolvedValueOnce({ rowCount: 2 });

      const { markInjected } = await import("./compound.js");
      await markInjected(mockPool as never, [1, 5]);

      const [sql, params] = mockPool.query.mock.calls.at(0) as [string, unknown[]];
      expect(sql).toContain("times_injected = times_injected + 1");
      expect(params).toEqual([[1, 5]]);
    });

    it("should skip query when ids array is empty", async () => {
      const mockPool = createMockPool();

      const { markInjected } = await import("./compound.js");
      await markInjected(mockPool as never, []);

      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });
});
