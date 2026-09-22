import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnnounceDeliveryWithRetry } from "./subagent-announce-delivery-retry.js";

/**
 * Regression coverage for issue #118408: when several subagents finish inside
 * the same short window, they all hit the same writer-claim-rebound conflict
 * and previously retried a fixed [5s, 10s, 20s] schedule with no jitter,
 * resyncing and colliding again at the same instants instead of spreading
 * out. These tests pin the schedule to fast, deterministic values and assert
 * the applied delay is jittered (spread across a range), never shrunk below
 * the base delay, and that concurrent callers do not resolve their retry
 * waits at exactly the same instant.
 */
describe("runAnnounceDeliveryWithRetry jitter", () => {
  const originalTestFast = process.env.OPENCLAW_TEST_FAST;

  beforeEach(() => {
    vi.useFakeTimers();
    // Force the non-"fast test runtime" branch so jitter is exercised even
    // though these tests themselves run under vitest.
    delete process.env.OPENCLAW_TEST_FAST;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTestFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = originalTestFast;
    }
  });

  it("spreads concurrent retries instead of resolving them at the exact same instant", async () => {
    const transientError = Object.assign(new Error("gateway timeout after 5000ms"), {});

    async function runOnce(alwaysFailUntil: number) {
      let attempts = 0;
      const resolvedAtMs: number[] = [];
      const resultPromise = runAnnounceDeliveryWithRetry({
        operation: "test",
        run: async () => {
          attempts += 1;
          resolvedAtMs.push(Date.now());
          if (attempts <= alwaysFailUntil) {
            throw transientError;
          }
          return "ok";
        },
      });
      // Drain the fake-timer queue as delays elapse.
      await vi.runAllTimersAsync();
      await resultPromise;
      return resolvedAtMs;
    }

    // Three "concurrent" competitors that each fail once, then succeed on
    // their first retry — mirrors five subagents colliding on the same
    // writer-claim-rebound error at t=0.
    const [a, b, c] = await Promise.all([runOnce(1), runOnce(1), runOnce(1)]);

    const firstRetryAt = [a[1], b[1], c[1]];
    // All three retries land within the [5000ms, 6500ms] jitter window …
    for (const t of firstRetryAt) {
      expect(t).toBeGreaterThanOrEqual(5_000);
      expect(t).toBeLessThanOrEqual(5_000 * 1.3 + 1);
    }
    // … but with independent jitter draws, they should not all coincide on
    // the same millisecond (this is what caused repeated lockstep collisions
    // pre-fix; a flake here would mean Math.random() drew three identical
    // values, astronomically unlikely).
    expect(new Set(firstRetryAt).size).toBeGreaterThan(1);
  });

  it("never returns a delay shorter than the base schedule value", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const start = Date.now();
      const p = waitForAnnounceRetryDelayForTest();
      await vi.runAllTimersAsync();
      await p;
      samples.push(Date.now() - start);
    }
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(5_000);
      expect(sample).toBeLessThanOrEqual(5_000 * 1.3 + 1);
    }
  });

  function waitForAnnounceRetryDelayForTest() {
    // Exercise the real retry path (one forced transient failure, one
    // success) so the jittered delay is the one actually awaited by
    // runAnnounceDeliveryWithRetry, not a re-implementation of the formula.
    let attempts = 0;
    return runAnnounceDeliveryWithRetry({
      operation: "test",
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("gateway timeout after 5000ms");
        }
        return "ok";
      },
    });
  }
});
