import { describe, expect, it } from "vitest";
import {
  loadFinalDeliveryState,
  recordFinalDeliveryFailure,
  recordFinalDeliverySuccess,
  resolveFinalDeliveryResumeDecision,
} from "./subagent-final-delivery-state.js";
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
    expectsCompletionMessage: true,
    ...overrides,
  };
}

describe("subagent final delivery state", () => {
  it("keeps transient completion delivery retryable past the normal announce retry count", () => {
    const entry = makeEntry({ announceRetryCount: 3 });

    const state = recordFinalDeliveryFailure({
      entry,
      now: 2_000,
      hardExpiryMs: 30 * 60_000,
      retryDelayMs: 8_000,
      error: {
        message: "gateway timeout after 120000ms",
        retryability: "transient",
        path: "direct",
      },
    });

    expect(state).toEqual({
      kind: "retrying",
      attemptCount: 4,
      nextRetryAt: 10_000,
      lastError: {
        message: "gateway timeout after 120000ms",
        retryability: "transient",
        path: "direct",
      },
    });
    expect(entry.pendingFinalDelivery).toBe(true);
    expect(entry.cleanupCompletedAt).toBeUndefined();
  });

  it("makes permanent completion delivery failure terminal", () => {
    const entry = makeEntry();

    const state = recordFinalDeliveryFailure({
      entry,
      now: 2_000,
      hardExpiryMs: 30 * 60_000,
      retryDelayMs: 1_000,
      error: {
        message: "chat not found",
        retryability: "permanent",
        path: "direct",
      },
    });

    expect(state).toEqual({
      kind: "terminal_failed",
      reason: "permanent-failure",
      error: {
        message: "chat not found",
        retryability: "permanent",
        path: "direct",
      },
    });
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.lastAnnounceDeliveryRetryable).toBe(false);
  });

  it("hard-expires pending completion delivery", () => {
    const entry = makeEntry({
      finalDeliveryState: {
        kind: "retrying",
        attemptCount: 5,
        nextRetryAt: 20_000,
        lastError: {
          message: "gateway timeout",
          retryability: "transient",
          path: "direct",
        },
      },
    });

    expect(
      loadFinalDeliveryState({
        entry,
        now: 31 * 60_000,
        hardExpiryMs: 30 * 60_000,
      }),
    ).toEqual({
      kind: "expired",
      expiredAt: 31 * 60_000,
      lastError: {
        message: "gateway timeout",
        retryability: "transient",
        path: "direct",
      },
    });
  });

  it("schedules retry on resume until retry time is due", () => {
    const entry = makeEntry({
      finalDeliveryState: {
        kind: "retrying",
        attemptCount: 2,
        nextRetryAt: 5_000,
      },
    });

    expect(
      resolveFinalDeliveryResumeDecision({
        entry,
        now: 4_000,
        hardExpiryMs: 30 * 60_000,
      }),
    ).toEqual({ kind: "schedule", delayMs: 1_000 });
    expect(
      resolveFinalDeliveryResumeDecision({
        entry,
        now: 5_000,
        hardExpiryMs: 30 * 60_000,
      }),
    ).toEqual({ kind: "attempt" });
  });

  it("marks delivered state terminal for cleanup", () => {
    const entry = makeEntry({
      pendingFinalDelivery: true,
      pendingFinalDeliveryPayload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        task: "test",
      },
    });

    recordFinalDeliverySuccess(entry, 4_000);

    expect(entry.finalDeliveryState).toEqual({ kind: "delivered", deliveredAt: 4_000 });
    expect(entry.completionAnnouncedAt).toBe(4_000);
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.pendingFinalDeliveryPayload).toBeUndefined();
  });
});
