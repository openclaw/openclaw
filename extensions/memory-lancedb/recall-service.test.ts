import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runWithTimeout } from "./embeddings.js";
import { startMemoryRecall } from "./recall-service.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("memory-lancedb recall deadline", () => {
  test("rejects task success after the recall deadline", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);
    const pending = createDeferred<string>();
    const result = runWithTimeout({
      timeoutMs: 15_000,
      task: () => pending.promise,
    });
    await Promise.resolve();

    nowSpy.mockReturnValue(15_000);
    pending.resolve("late success");

    await expect(result).resolves.toEqual({ status: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the embed/search budget monotonic, integer, and skew-proof", async () => {
    vi.useFakeTimers();
    // performance.now returns a float (the real monotonic clock does); the
    // budget must be floored so downstream AbortSignal.timeout never sees one.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000.25);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    let embedBudget = 0;
    let searchBudget = 0;
    startMemoryRecall({
      timeoutMs: 60_000,
      embed: async (readBudget) => {
        // Monotonic clock advances 1.5ms; the wall clock rolls back 10s.
        nowSpy.mockReturnValue(1_001.75);
        dateNowSpy.mockReturnValue(0);
        embedBudget = readBudget();
        return [0.1, 0.2, 0.3];
      },
      search: async (_vector, budget) => {
        searchBudget = budget;
        return [];
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    // deadlineAtMs = 1000.25 + 60000 = 61000.25; both budgets = 61000.25 -
    // 1001.75 = 59998.5, floored to 59998. The wall-clock rollback does not
    // change them; a wall-clock read would have inflated them to 69998.5.
    expect(embedBudget).toBe(59_998);
    expect(searchBudget).toBe(59_998);
  });
});
