import { describe, it, expect, vi } from "vitest";
import { MemoryQueue } from "./queue.js";

describe("MemoryQueue", () => {
  it("should execute tasks sequentially with delay", async () => {
    const queue = new MemoryQueue({ delayMs: 100 });
    const sequence: number[] = [];

    const task1 = async () => {
      await new Promise((r) => setTimeout(r, 50));
      sequence.push(1);
    };

    const task2 = async () => {
      sequence.push(2);
    };

    queue.push("task1", task1);
    queue.push("task2", task2);

    // Initial state: nothing processed yet (tasks are async/queued)
    expect(sequence).toEqual([]);

    // Wait enough time for task1 + delay + task2
    await new Promise((r) => setTimeout(r, 300));

    expect(sequence).toEqual([1, 2]);
  });

  it("should continue processing if a task fails", async () => {
    const queue = new MemoryQueue({ delayMs: 10 });
    const sequence: string[] = [];

    queue.push("fail", async () => {
      throw new Error("Boom");
    });

    queue.push("success", async () => {
      sequence.push("ok");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(sequence).toEqual(["ok"]);
  });

  it("should prevent concurrent execution (concurrency: 1)", async () => {
    const queue = new MemoryQueue({ delayMs: 0 });
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 20));
      concurrentCount--;
    };

    queue.push("t1", task);
    queue.push("t2", task);
    queue.push("t3", task);

    await new Promise((r) => setTimeout(r, 100));

    expect(maxConcurrent).toBe(1);
  });
});
