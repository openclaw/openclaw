import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

describe("pi-embedded-runner runs", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs when mode=compacting", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortA,
    });

    setActiveEmbeddedRun("session-b", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).not.toHaveBeenCalled();
  });

  it("aborts all runs when mode=all", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortA,
    });

    setActiveEmbeddedRun("session-b", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active embedded runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const abortA = vi.fn();
      const handle = {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: abortA,
      };
      setActiveEmbeddedRun("session-a", handle);

      // Drain after 500ms
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const drainPromise = waitForActiveEmbeddedRuns(1000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const out = await drainPromise;
      expect(out.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      });

      const drainPromise = waitForActiveEmbeddedRuns(1000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1000);
      const out = await drainPromise;
      expect(out.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
