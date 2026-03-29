import { describe, test, expect, vi, beforeEach } from "vitest";
import { ApiRateLimiter } from "./limiter.js";
import { TaskPriority } from "./limiter.js";
import { MemoryQueue } from "./queue.js";
import { MemoryTracer } from "./tracer.js";

describe("Concurrency & Stress Testing", () => {
  test("Limiter handles massive burst without crashing", async () => {
    const limiter = new ApiRateLimiter({
      minDelayMs: 10,
      maxRequestsPerMinute: 100,
    });

    const results: number[] = [];
    const tasks = Array.from({ length: 50 }).map((_, i) =>
      limiter.execute(async () => {
        results.push(i);
        return i;
      }, TaskPriority.NORMAL),
    );

    await Promise.all(tasks);
    expect(results.length).toBe(50);
  });

  test("Queue respects maxSize and drops tasks", async () => {
    const errors: string[] = [];
    const queue = new MemoryQueue({
      maxSize: 5,
      delayMs: 10,
      onError: (name, err) => errors.push(String(err)),
    });

    for (let i = 0; i < 15; i++) {
      queue.push(`task-${i}`, async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }

    expect(queue.size).toBeLessThanOrEqual(5);
    expect(errors.length).toBeGreaterThan(0);
  });
});
