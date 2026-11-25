// Subagent delivery-state tests cover current registry record normalization.
import { describe, expect, it } from "vitest";
import {
  completeRequesterSettleWakeState,
  normalizeSubagentRunState,
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

describe("subagent retirement rule", () => {
  it("folds retire intent from rows written by older builds into the row fact", () => {
    const fromWake = normalizeSubagentRunState(
      baseRun({
        requesterSettleWake: { status: "pending", attemptCount: 0, retireAfterSettle: true },
      } as Partial<SubagentRunRecord>),
    );
    const fromRow = normalizeSubagentRunState(
      baseRun({ retireAfterRequesterTurn: true } as Partial<SubagentRunRecord>),
    );

    expect(fromWake.retireAfterSettle).toBe(true);
    expect(fromWake.requesterSettleWake).toEqual({ status: "pending", attemptCount: 0 });
    expect(fromRow.retireAfterSettle).toBe(true);
    expect(fromRow).not.toHaveProperty("retireAfterRequesterTurn");
  });

  it("keeps retire intent while the requester turn still awaits the result", () => {
    const entry = baseRun({
      retireAfterSettle: true,
      requesterTurnRunId: "requester-turn",
      requesterSettleWake: { status: "dispatching", attemptCount: 1 },
    });

    expect(completeRequesterSettleWakeState(entry)).toBe(false);
    expect(entry.retireAfterSettle).toBe(true);
    entry.requesterTurnRunId = undefined;
    expect(completeRequesterSettleWakeState(entry)).toBe(true);
  });

  it("keeps a paused child's retire intent until its next settle", () => {
    const entry = baseRun({
      retireAfterSettle: true,
      pauseReason: "sessions_yield",
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });

    expect(completeRequesterSettleWakeState(entry)).toBe(false);
    expect(entry.retireAfterSettle).toBe(true);
    entry.pauseReason = undefined;
    expect(completeRequesterSettleWakeState(entry)).toBe(true);
  });
});
