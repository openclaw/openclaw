import { describe, expect, it } from "vitest";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: 0,
    endedAt: 1_000,
    ...overrides,
  };
}

describe("resolveDeferredCleanupDecision", () => {
  const now = 2_000;

  it("defers completion-message cleanup while descendants are still pending", () => {
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: true }),
      now,
      activeDescendantRuns: 2,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("hard-expires completion-message cleanup when descendants never settle", () => {
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: true, endedAt: now - (30 * 60_000 + 1) }),
      now,
      activeDescendantRuns: 1,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("keeps regular expiry behavior for non-completion flows", () => {
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: false, endedAt: now - (5 * 60_000 + 1) }),
      now,
      activeDescendantRuns: 0,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry", retryCount: 1 });
  });

  // --- Tests for the descendant-retry-race fix ---

  it("defers non-completion runs while descendants are still pending", () => {
    // This is the core fix: previously only completionMessage flows deferred
    // for active descendants. Non-completion runs would fall through to the
    // retry path, consuming the retry budget without attempting delivery.
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: false }),
      now,
      activeDescendantRuns: 1,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("hard-expires non-completion runs with stuck descendants after announceExpiryMs", () => {
    // Safety valve: if descendants are permanently stuck, non-completion runs
    // should eventually give up using the regular expiry (not loop forever).
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: false, endedAt: now - (5 * 60_000 + 1) }),
      now,
      activeDescendantRuns: 1,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("does not consume retry budget when descendants are active (non-completion)", () => {
    // Verify that active descendants trigger defer, not retry, regardless of
    // the current retry count. The retry counter should not be incremented.
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: false, announceRetryCount: 2 }),
      now,
      activeDescendantRuns: 1,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    // Should defer, NOT give-up despite retryCount being at 2
    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  // --- End descendant-retry-race fix tests ---

  it("uses retry backoff for completion-message flows once descendants are settled", () => {
    const decision = resolveDeferredCleanupDecision({
      entry: makeEntry({ expectsCompletionMessage: true, announceRetryCount: 1 }),
      now,
      activeDescendantRuns: 0,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });
});
