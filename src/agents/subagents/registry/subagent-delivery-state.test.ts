// Subagent delivery-state tests cover current registry record normalization.
import { describe, expect, it } from "vitest";
import {
  normalizeSubagentRunState,
  recordRequesterDelivery,
  resolveRequesterDeliveryOutcome,
  resolveConsumedRequesterDeliveryOutcome,
  clearSubagentPendingDelivery,
} from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function baseRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:parent",
    requesterDisplayKey: "agent:main:parent",
    controllerSessionKey: "agent:main:parent",
    task: "inspect",
    cleanup: "keep",
    spawnMode: "run",
    createdAt: 100,
    expectsCompletionMessage: true,
    execution: { status: "running", startedAt: 100 },
    completion: { required: true },
    delivery: { status: "pending" },
    ...overrides,
  };
}

describe("normalizeSubagentRunState", () => {
  it("normalizes the durable delete-dispatch boundary", () => {
    const valid = normalizeSubagentRunState(baseRun({ deleteCleanupDispatchedAt: 200 }));
    const malformed = normalizeSubagentRunState(baseRun({ deleteCleanupDispatchedAt: Number.NaN }));

    expect(valid.deleteCleanupDispatchedAt).toBe(200);
    expect(malformed.deleteCleanupDispatchedAt).toBeUndefined();
  });

  it("preserves valid killed reconciliation ownership metadata", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        suppressCompletionDelivery: true,
        killReconciliation: {
          killedAt: 200,
          suppressTaskDelivery: true,
          supersededAt: 300,
        },
      }),
    );

    expect(entry.killReconciliation).toEqual({
      killedAt: 200,
      suppressTaskDelivery: true,
      supersededAt: 300,
    });
    expect(entry.suppressCompletionDelivery).toBe(true);
  });

  it("clears stale cleanupHandled locks after delivered notification if cleanup did not finish", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "delivered",
          announcedAt: 400,
        },
      }),
    );

    expect(entry.cleanupHandled).toBe(false);
  });
});

describe("requester consumption", () => {
  it("does not downgrade consumption to waiting or erase it during cleanup", () => {
    const entry = baseRun();
    recordRequesterDelivery(entry, { state: "consumed", runId: "requester", at: 10 });
    recordRequesterDelivery(entry, { state: "waiting", runId: "retry" });
    clearSubagentPendingDelivery(entry);
    expect(entry.delivery?.requesterDelivery).toEqual({
      state: "consumed",
      runId: "requester",
      at: 10,
    });
  });

  it("distinguishes a failed turn from an answered turn and a refused delivery", () => {
    const entry = baseRun();
    recordRequesterDelivery(entry, { state: "consumed", runId: "requester" });
    const failure = { delivered: false, path: "direct" as const };
    expect(resolveRequesterDeliveryOutcome([entry], failure)?.delivered).toBe(true);
    const answered = {
      ...failure,
      finalAssistantVisibleText: "answer",
      reason: "message_tool_delivery_missing" as const,
    };
    expect(resolveRequesterDeliveryOutcome([entry], answered)).toBe(answered);
    const refused = { ...failure, disposition: "intentional_non_delivery" as const };
    expect(resolveRequesterDeliveryOutcome([entry], refused)).toBe(refused);
    entry.completionTarget = "parent";
    const missed = { ...failure, reason: "message_tool_delivery_missing" as const };
    expect(resolveRequesterDeliveryOutcome([entry], missed)).toBe(missed);
    const sendFailed = { ...failure, reason: "delivery_failed" as const };
    expect(resolveRequesterDeliveryOutcome([entry], sendFailed)).toBe(sendFailed);
    const ambiguous = { ...failure, disposition: "ambiguous" as const };
    expect(resolveRequesterDeliveryOutcome([entry], ambiguous)).toBe(ambiguous);
    const blocked = { ...failure, reason: "delivery_suppressed" as const };
    expect(resolveRequesterDeliveryOutcome([entry], blocked)).toBe(blocked);
    expect(resolveRequesterDeliveryOutcome([entry, baseRun()], failure)).toBe(failure);
  });

  it.each([undefined, "ambiguous"] as const)(
    "retains recorded send failure during consumed receipt recovery (%s)",
    (disposition) => {
      const entry = baseRun({
        delivery: {
          status: "failed",
          disposition,
          lastError: "platform send failed",
          requesterDelivery: { state: "consumed", runId: "requester" },
        },
      });
      expect(resolveConsumedRequesterDeliveryOutcome([entry])).toMatchObject({
        delivered: false,
        disposition: disposition ?? "permanent_failure",
        error: "platform send failed",
      });
    },
  );
});
