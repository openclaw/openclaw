import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mergeFactsBatch } from "./consolidate.js";
import { MemoryDB } from "./database.js";
import memoryPlugin from "./index.js";

describe("Hardening V2 Tests", () => {
  describe("P1-1: mergeFactsBatch Index Alignment", () => {
    test("should mock return array with nulls indicating failed merges, without shifting indices", async () => {
      const mockChat: any = {
        complete: vi.fn().mockResolvedValue(`["Fact 1 merged", null, "Fact 3 merged"]`),
      };
      const clusters = [
        ["fact1a", "fact1b"],
        ["fact2a", "fact2b"],
        ["fact3a", "fact3b"],
      ];

      const results = await mergeFactsBatch(clusters, mockChat);

      expect(results.length).toBe(3);
      expect(results[0]).toBe("Fact 1 merged");
      expect(results[1]).toBeNull();
      expect(results[2]).toBe("Fact 3 merged");
    });
  });

  describe("P1-2: Sequential LanceDB updates in flushRecallCounts", () => {
    test("should execute update serially to prevent MVCC deadlock and prevent unhandled promise rejections", async () => {
      const db = new MemoryDB("/tmp/db", 384, {} as any, {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      });

      // Setup fake data
      db.incrementRecallCount(["id-1", "id-2", "id-3"]);

      let concurrentUpdates = 0;
      let maxConcurrent = 0;

      const mockTable = {
        query: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockReturnThis(),
        update: vi.fn().mockImplementation(async () => {
          concurrentUpdates++;
          if (concurrentUpdates > maxConcurrent) maxConcurrent = concurrentUpdates;
          // fake delay to force overlap if run with Promise.all
          await new Promise((r) => setTimeout(r, 10));
          concurrentUpdates--;
          return true;
        }),
      };

      (db as any).table = mockTable;
      (db as any).availableColumns = new Set(["id", "recallCount"]);
      db.getByIds = vi.fn().mockResolvedValue([
        { id: "id-1", recallCount: 1 },
        { id: "id-2", recallCount: 1 },
        { id: "id-3", recallCount: 1 },
      ]);
      (db as any).initPromise = Promise.resolve();

      await db.flushRecallCounts();

      expect(mockTable.update).toHaveBeenCalledTimes(3);
      // It should NOT run in parallel, meaning maxConcurrent should be 1
      expect(maxConcurrent).toBe(1);
    });
  });

  describe("P1-3: Lifecycle completeness", () => {
    test("should define start and stop as async functions on plugin service", () => {
      let registeredService: any = null;
      const api: OpenClawPluginApi = {
        pluginConfig: {
          dbPath: "memory.db",
          embedding: { apiKey: "fake-key", model: "text-embedding-004", outputDimensionality: 384 },
          chatModel: "fake-chat",
          chatApiKey: "fake-key",
        },
        resolvePath: (p: string) => `/tmp/${p}`,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerService: (service: any) => {
          registeredService = service;
        },
        registerTool: vi.fn(),
        registerCli: vi.fn(),
        registerHook: vi.fn().mockReturnValue(true),
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      // Ensure mock graphDB and workingMemory are injected or we test it by checking function types
      memoryPlugin.register(api);

      expect(registeredService).toBeTruthy();
      // start and stop should be async (returning a Promise, typically constructor name is AsyncFunction)
      expect(registeredService.start.constructor.name).toBe("AsyncFunction");
      expect(registeredService.stop.constructor.name).toBe("AsyncFunction");
    });
  });
});
