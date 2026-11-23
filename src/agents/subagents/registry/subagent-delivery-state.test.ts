// Subagent delivery-state tests cover current registry record normalization.
import { describe, expect, it } from "vitest";
import {
  normalizeSubagentRunState,
  recordRequesterDelivery,
  resolveRequesterDeliveryOutcome,
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

it("keeps an ambiguous send when the requester consumed the result first", () => {
  const run = baseRun();
  recordRequesterDelivery(run, { state: "consumed", runId: "requester-turn" });
  const outcome = {
    delivered: false,
    path: "direct",
    disposition: "ambiguous",
    error: "automatic completion delivery could not be confirmed",
  } as const;

  expect(resolveRequesterDeliveryOutcome([run], outcome)).toEqual(outcome);
});

it("keeps recorded send ambiguity when transcript consumption arrives later", () => {
  const run = baseRun({
    delivery: {
      status: "pending",
      disposition: "ambiguous",
      lastError: "send returned no identity",
    },
  });
  recordRequesterDelivery(run, { state: "consumed", runId: "requester-turn" });

  expect(run.delivery).toMatchObject({
    status: "pending",
    disposition: "ambiguous",
    lastError: "send returned no identity",
    requesterDelivery: { state: "consumed", runId: "requester-turn" },
  });
  const receipt = { delivered: true, path: "direct", deliveredAt: 200 } as const;
  expect(resolveRequesterDeliveryOutcome([run], receipt)).toEqual(receipt);
});
