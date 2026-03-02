import { describe, expect, it } from "vitest";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function buildRun(partial?: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:orchestrator",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "orchestrate",
    cleanup: "keep",
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    expectsCompletionMessage: true,
    ...partial,
  };
}

describe("subagent registry cleanup decisions", () => {
  it("keeps deferring completion-message announces while descendants are still active", () => {
    const now = 10 * 60_000;
    const decision = resolveDeferredCleanupDecision({
      entry: buildRun({ endedAt: 0 }),
      now,
      activeDescendantRuns: 2,
      announceExpiryMs: 5 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 1_000,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("does not expire completion-message announces just because descendants took a long time", () => {
    const now = 10 * 60_000;
    const decision = resolveDeferredCleanupDecision({
      entry: buildRun({ endedAt: 0 }),
      now,
      activeDescendantRuns: 0,
      announceExpiryMs: 5 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({
      kind: "retry",
      retryCount: 1,
      resumeDelayMs: 2_000,
    });
  });

  it("still expires stale non-completion announces", () => {
    const now = 10 * 60_000;
    const decision = resolveDeferredCleanupDecision({
      entry: buildRun({ expectsCompletionMessage: false, endedAt: 0 }),
      now,
      activeDescendantRuns: 0,
      announceExpiryMs: 5 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({
      kind: "give-up",
      reason: "expiry",
      retryCount: 1,
    });
  });
});
