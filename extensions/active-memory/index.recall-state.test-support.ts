import { vi } from "vitest";
import * as recallState from "./recall-state.js";
import { forgetTriggerRecallRun } from "./trigger-recall.js";

export function createRecallStateFixture() {
  const promptRuns: Array<{ runId: string; promise: Promise<unknown> }> = [];
  const timeoutCleanups: Promise<void>[] = [];
  const circuitKeys = new Set<string>();

  return {
    trackRun(runId: unknown, promise: Promise<unknown>): void {
      if (typeof runId === "string") {
        promptRuns.push({ runId, promise });
      }
    },
    expireCacheAfter(ttlMs: number) {
      const lookup = recallState.getCachedResult;
      const expiredAt = Date.now() + ttlMs;
      return vi.spyOn(recallState, "getCachedResult").mockImplementation((cacheKey) => {
        using _ = vi.spyOn(Date, "now").mockReturnValue(expiredAt);
        return lookup(cacheKey);
      });
    },
    observe() {
      const scheduleCleanup = recallState.scheduleMemorySearchCleanupAfterTimeout;
      vi.spyOn(recallState, "scheduleMemorySearchCleanupAfterTimeout").mockImplementation(
        (...args) => {
          const cleanup = scheduleCleanup(...args);
          if (promptRuns.length > 0) {
            timeoutCleanups.push(cleanup);
          }
          return cleanup;
        },
      );
      const recordTimeout = recallState.recordCircuitBreakerTimeout;
      vi.spyOn(recallState, "recordCircuitBreakerTimeout").mockImplementation((key, cooldownMs) => {
        circuitKeys.add(key);
        recordTimeout(key, cooldownMs);
      });
    },
    async cleanup() {
      await Promise.allSettled(promptRuns.map(({ promise }) => promise));
      await Promise.allSettled(timeoutCleanups);
      for (const { runId } of promptRuns) {
        recallState.forgetActiveRecallRun(runId);
        forgetTriggerRecallRun(runId);
      }
      for (const key of circuitKeys) {
        recallState.resetCircuitBreaker(key);
      }
      circuitKeys.clear();
      promptRuns.length = 0;
      timeoutCleanups.length = 0;
    },
  };
}
