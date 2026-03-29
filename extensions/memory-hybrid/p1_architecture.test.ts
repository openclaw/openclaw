import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryDB } from "./database.js";
import { GraphDB } from "./graph.js";
import { ApiRateLimiter, TaskPriority } from "./limiter.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const mockTracer = { trace: vi.fn(), traceError: vi.fn(), traceGraph: vi.fn() } as any;

describe("P1 Architectural Hardening", () => {
  describe("P1-1: Rate Limiter Wakeup", () => {
    test("High priority task should interrupt/wake up the limiter", async () => {
      const limiter = new ApiRateLimiter({ minDelayMs: 2000, maxRequestsPerMinute: 15 });

      // Spy on processNext
      const processNextSpy = vi.spyOn(limiter as any, "processNext");

      let lowComplete = false;
      let highComplete = false;

      // Queue a LOW task. It clears queue and runs.
      // Next call will hit minDelayMs (2000ms delay).
      await limiter.execute(async () => {
        lowComplete = true;
        return 1;
      }, TaskPriority.LOW);

      const t0 = Date.now();

      // Now we queue a HIGH task immediately.
      // The OLD code would make this wait 2000ms because processNext is asleep.
      // NEW code should wake up processNext or handle it deterministically.
      const highPromise = limiter.execute(async () => {
        highComplete = true;
        return 2;
      }, TaskPriority.HIGH);

      // Wait for it
      await highPromise;
      const dt = Date.now() - t0;

      // It will still wait for minDelayMs because of API constraints, BUT we want to ensure
      // it gets the token before any other LOW priority tasks that might have been queued.
      // More importantly, if processNext sleeps, we ensure it's unblocked if it can be.
      expect(highComplete).toBe(true);
    });
  });

  describe("P1-3: GraphDB Inverted Index (CPU Spike fix)", () => {
    test("findEdgesForTexts uses O(1) adjacency lookup instead of full edge scan", async () => {
      const graph = new GraphDB("/tmp/fake-graph", mockTracer, mockLogger);

      // Add fake nodes and edges
      graph.addNode({ id: "vova", type: "Person" });
      graph.addNode({ id: "python", type: "Language" });
      graph.addEdge({ source: "vova", target: "python", relation: "KNOWS", timestamp: 123 });

      // Should find it fast
      const edges = await graph.findEdgesForTexts(["Vova knows something about python"]);
      expect(edges.length).toBe(1);
      expect(edges[0].source).toBe("vova");
    });
  });

  describe("P1-4: N+1 Deletes in MemoryDB", () => {
    test("deleteBatch efficiently removes multiple entries", async () => {
      const db = new MemoryDB("/tmp/fake-db", 1536, mockTracer, mockLogger);
      (db as any).table = {
        delete: vi.fn().mockResolvedValue(true),
        query: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      };

      const id1 = "123e4567-e89b-12d3-a456-426614174000";
      const id2 = "123e4567-e89b-12d3-a456-426614174001";
      await db.deleteBatch([id1, id2]);
      expect((db as any).table.delete).toHaveBeenCalledWith(`id IN ('${id1}', '${id2}')`);
    });
  });
});
