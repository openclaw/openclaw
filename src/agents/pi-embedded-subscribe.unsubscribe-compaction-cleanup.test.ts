import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession - unsubscribe compaction cleanup", () => {
  it("waits for compaction end event before completing unsubscribe", async () => {
    const abortCompaction = vi.fn();
    const sessionUnsubscribe = vi.fn();

    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-cleanup-test",
      sessionExtras: {
        isCompacting: true,
        abortCompaction,
        subscribe: () => sessionUnsubscribe,
      },
    });

    // Start compaction
    emit({ type: "auto_compaction_start" });

    // Unsubscribe should wait for compaction cleanup
    const unsubscribePromise = subscription.unsubscribe();

    // abortCompaction should be called immediately
    expect(abortCompaction).toHaveBeenCalledTimes(1);

    // sessionUnsubscribe should NOT be called yet (waiting for cleanup)
    expect(sessionUnsubscribe).not.toHaveBeenCalled();

    // Simulate SDK emitting compaction end event after abort
    emit({ type: "auto_compaction_end", willRetry: false, aborted: true });

    // Now wait for unsubscribe to complete
    await unsubscribePromise;

    // sessionUnsubscribe should be called after compaction end is processed
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("times out and unsubscribes if compaction end event never arrives", async () => {
    const abortCompaction = vi.fn();
    const sessionUnsubscribe = vi.fn();

    const { subscription } = createSubscribedSessionHarness({
      runId: "run-timeout-test",
      sessionExtras: {
        isCompacting: true,
        abortCompaction,
        subscribe: () => sessionUnsubscribe,
      },
    });

    // Unsubscribe without emitting compaction end event
    const startTime = Date.now();
    await subscription.unsubscribe();
    const elapsed = Date.now() - startTime;

    // Should complete within reasonable time (timeout is 5000ms)
    expect(elapsed).toBeLessThan(6000);

    // sessionUnsubscribe should still be called even on timeout
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("immediately unsubscribes when no compaction is in flight", async () => {
    const abortCompaction = vi.fn();
    const sessionUnsubscribe = vi.fn();

    const { subscription } = createSubscribedSessionHarness({
      runId: "run-no-compaction-test",
      sessionExtras: {
        isCompacting: false,
        abortCompaction,
        subscribe: () => sessionUnsubscribe,
      },
    });

    await subscription.unsubscribe();

    // abortCompaction should not be called when not compacting
    expect(abortCompaction).not.toHaveBeenCalled();

    // sessionUnsubscribe should be called immediately
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("handles multiple unsubscribe calls gracefully", async () => {
    const abortCompaction = vi.fn();
    const sessionUnsubscribe = vi.fn();

    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-multiple-unsubscribe-test",
      sessionExtras: {
        isCompacting: true,
        abortCompaction,
        subscribe: () => sessionUnsubscribe,
      },
    });

    emit({ type: "auto_compaction_start" });

    // Call unsubscribe twice concurrently
    const promise1 = subscription.unsubscribe();
    const promise2 = subscription.unsubscribe();

    // Emit compaction end
    emit({ type: "auto_compaction_end", willRetry: false, aborted: true });

    await Promise.all([promise1, promise2]);

    // abortCompaction should only be called once
    expect(abortCompaction).toHaveBeenCalledTimes(1);

    // sessionUnsubscribe should only be called once
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
