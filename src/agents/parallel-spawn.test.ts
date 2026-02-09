import { describe, expect, it } from "vitest";
import {
  parallelWithLimit,
  spawnParallel,
  estimateThroughputImprovement,
  type SpawnTask,
} from "./parallel-spawn.js";

describe("parallel-spawn", () => {
  describe("parallelWithLimit", () => {
    it("executes all items", async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await parallelWithLimit(items, 3, async (n) => n * 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it("respects concurrency limit", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const items = [1, 2, 3, 4, 5, 6];
      await parallelWithLimit(items, 2, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("handles empty input", async () => {
      const results = await parallelWithLimit([], 3, async (n) => n);
      expect(results).toEqual([]);
    });

    it("preserves order", async () => {
      const items = [30, 10, 20];
      const results = await parallelWithLimit(items, 3, async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      });
      expect(results).toEqual([30, 10, 20]);
    });
  });

  describe("spawnParallel", () => {
    it("spawns all tasks", async () => {
      const tasks: SpawnTask[] = [
        { task: "audit code", label: "audit" },
        { task: "check costs", label: "costs" },
        { task: "security review", label: "security" },
      ];

      const results = await spawnParallel({
        tasks,
        spawnFn: async (task) => ({
          status: "accepted",
          childSessionKey: `session:${task.label}`,
          runId: `run:${task.label}`,
        }),
      });

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === "accepted")).toBe(true);
      expect(results[0]!.label).toBe("audit");
    });

    it("handles spawn errors", async () => {
      const tasks: SpawnTask[] = [{ task: "fail", label: "bad" }];

      const results = await spawnParallel({
        tasks,
        spawnFn: async () => {
          throw new Error("spawn failed");
        },
      });

      expect(results[0]!.status).toBe("error");
      expect(results[0]!.error).toBe("spawn failed");
    });

    it("handles timeouts", async () => {
      const tasks: SpawnTask[] = [{ task: "slow", label: "slow" }];

      const results = await spawnParallel({
        tasks,
        spawnFn: async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return { status: "accepted" };
        },
        config: { spawnTimeoutMs: 50 },
      });

      expect(results[0]!.status).toBe("timeout");
    });

    it("returns empty for no tasks", async () => {
      const results = await spawnParallel({
        tasks: [],
        spawnFn: async () => ({ status: "accepted" }),
      });
      expect(results).toEqual([]);
    });

    it("tracks duration", async () => {
      const tasks: SpawnTask[] = [{ task: "timed", label: "t" }];
      const results = await spawnParallel({
        tasks,
        spawnFn: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { status: "accepted" };
        },
      });
      expect(results[0]!.durationMs).toBeGreaterThanOrEqual(15);
    });
  });

  describe("estimateThroughputImprovement", () => {
    it("estimates improvement for parallel execution", () => {
      const result = estimateThroughputImprovement({
        taskCount: 3,
        avgTaskDurationMs: 10000,
        concurrency: 3,
      });
      expect(result.sequentialMs).toBe(30000);
      expect(result.parallelMs).toBe(10000);
      expect(result.improvementPercent).toBe(67);
    });

    it("handles single task", () => {
      const result = estimateThroughputImprovement({
        taskCount: 1,
        avgTaskDurationMs: 5000,
        concurrency: 3,
      });
      expect(result.improvementPercent).toBe(0);
    });

    it("handles concurrency > tasks", () => {
      const result = estimateThroughputImprovement({
        taskCount: 2,
        avgTaskDurationMs: 10000,
        concurrency: 5,
      });
      expect(result.parallelMs).toBe(10000);
      expect(result.improvementPercent).toBe(50);
    });
  });
});
