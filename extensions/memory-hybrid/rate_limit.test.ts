import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiRateLimiter, TaskPriority } from "./limiter.js";

describe("ApiRateLimiter", () => {
  let limiter: ApiRateLimiter;

  beforeEach(() => {
    // 100ms delay for faster testing
    limiter = new ApiRateLimiter({ minDelayMs: 100, maxRequestsPerMinute: 600 });
  });

  it("should enforce minimum delay between tasks", async () => {
    const start = Date.now();
    const results: number[] = [];

    const task = async (id: number) => {
      results.push(Date.now() - start);
    };

    // Run 3 tasks immediately
    await Promise.all([
      limiter.execute(() => task(1)),
      limiter.execute(() => task(2)),
      limiter.execute(() => task(3)),
    ]);

    expect(results.length).toBe(3);
    // Task 1: 0ms (approx)
    // Task 2: at least 100ms
    // Task 3: at least 200ms
    expect(results[1]).toBeGreaterThanOrEqual(100);
    expect(results[2]).toBeGreaterThanOrEqual(200);
  });

  it("should respect priorities (HIGH jumps ahead of LOW)", async () => {
    const results: string[] = [];

    // Slow down the limiter to ensure queue fills up
    const slowLimiter = new ApiRateLimiter({ minDelayMs: 50, maxRequestsPerMinute: 100 });

    // 1. Start a slow task to occupy the processor
    const p1 = slowLimiter.execute(async () => {
      results.push("FIRST");
    });

    // 2. Queue a LOW priority task
    const p2 = slowLimiter.execute(async () => {
      results.push("LOW");
    }, TaskPriority.LOW);

    // 3. Queue a HIGH priority task
    const p3 = slowLimiter.execute(async () => {
      results.push("HIGH");
    }, TaskPriority.HIGH);

    await Promise.all([p1, p2, p3]);

    // Expect HIGH to come before LOW (since they were both in queue while FIRST was processing or waiting)
    expect(results).toEqual(["FIRST", "HIGH", "LOW"]);
  });
});
