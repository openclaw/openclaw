import { expect, it, vi } from "vitest";
import { isDeliverySuspended } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { bindSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import { blockSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun,
  armRequesterWake,
  reopenCompletionFixtureOwners,
  records,
  requesterWakeDriver,
  readCompletionSystemEvents,
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const db = useCompletionDatabase("openclaw-expired-receipt-");

async function suspend(
  reason: "expiry" | "permanent_failure" = "expiry",
  completionTarget?: "parent",
  resultText: string | null = "canonical result",
) {
  const input = armRequesterWake(records());
  input.subagent.cleanupHandled = false;
  input.subagent.cleanupCompletedAt = undefined;
  input.subagent.delivery = { status: "pending", generation: 1 };
  input.subagent.completionTarget = completionTarget;
  input.subagent.completionRequesterSessionId = completionTarget ? "requester-session" : undefined;
  input.subagent.completion!.resultText = resultText;
  seedSubagentCompletionOwner({ ...input, databaseOptions: { database: db.value } });
  expect(
    await blockSubagentCompletionDelivery({
      subagent: input.subagent,
      reason: "completion delivery expired",
      suspendedReason: reason,
      databaseOptions: { database: db.value },
    }),
  ).toBe(true);
  input.subagent = currentCompletionRun(input);
  expect(isDeliverySuspended(input.subagent)).toBe(true);
  return input;
}

function settle(input: ReturnType<typeof records>, delivered: boolean) {
  return settleRequesterCompletionBatch({
    entries: [input.subagent],
    outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
    assertCurrent: () => {},
    databaseOptions: { database: db.value },
  });
}

it("retains an admitted cleanup lock while publishing the requester receipt", async () => {
  const input = armRequesterWake(records());
  input.subagent.cleanupCompletedAt = undefined;
  input.subagent.delivery = { status: "pending", generation: 1 };
  seedSubagentCompletionOwner({ ...input, databaseOptions: { database: db.value } });

  await settle(input, true);

  expect(subagentRuns.get(input.subagent.runId)).not.toBe(input.subagent);
  expect(currentCompletionRun(input).cleanupHandled).toBe(true);
  expect(currentCompletionRun(input).cleanupCompletedAt).toBeUndefined();
  expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
  expect(currentCompletionRun(input).delivery?.status).toBe("delivered");
  db.value = await reopenCompletionFixtureOwners();
  // Process-local custody cannot survive a restart without durable completion.
  expect(currentCompletionRun(input).cleanupHandled).toBe(false);
  expect(currentCompletionRun(input).delivery?.status).toBe("delivered");
});

it.each([
  [undefined, "canonical result", true],
  ["parent", "canonical result", true],
  ["parent", null, true],
  [undefined, "canonical result", false],
  ["parent", "canonical result", false],
] as const)(
  "settles expiry (target=%s, result=%s, delivered=%s)",
  async (completionTarget, resultText, delivered) => {
    const input = await suspend("expiry", completionTarget, resultText);
    const before = structuredClone(input.subagent);
    const notices = readCompletionSystemEvents(db.value);
    if (!delivered) {
      expect(notices).toHaveLength(1);
    }
    const driver = requesterWakeDriver([input]);
    driver.wake.mockImplementation(async (params) => {
      await params.completeBatch(
        [input.subagent],
        1,
        delivered
          ? { delivered: true, path: "direct" }
          : { delivered: false, path: "none", error: "requester turn failed" },
      );
      return delivered;
    });
    try {
      await driver.run();
      if (delivered) {
        expect(driver.warn).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(isDeliverySuspended(currentCompletionRun(input))).toBe(false);
      }
      db.value = await reopenCompletionFixtureOwners();
      const stored = subagentRuns.get(input.subagent.runId);
      expect(stored?.requesterSettleWake).toBeUndefined();
      if (delivered) {
        expect(stored?.delivery?.status).toBe("delivered");
        for (const key of ["suspendedAt", "suspendedReason", "lastError", "payload"] as const) {
          expect(stored?.delivery?.[key]).toBeUndefined();
        }
        expect(stored?.completion?.resultText).toBe(resultText);
      } else {
        expect(stored).toMatchObject({
          delivery: {
            status: "failed",
            disposition: "permanent_failure",
            lastError: "requester turn failed",
          },
          suppressCompletionDelivery: true,
        });
        expect(stored?.completion).toEqual(before.completion);
        expect(stored?.delivery?.payload).toEqual(before.delivery?.payload);
        expect(readCompletionSystemEvents(db.value)).toEqual(notices);
      }
    } finally {
      driver.controller.clearRuntimeState();
    }
  },
);

it("does not recover permanent_failure from a successful receipt", async () => {
  const input = await suspend("permanent_failure");
  await settle(input, true);
  db.value = await reopenCompletionFixtureOwners();
  expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
});

it.each([
  "run",
  "execution",
  "host incarnation",
  "delivery generation",
  "registry write",
  "failed settlement write",
] as const)(
  "preserves the suspended delivery and wake when %s rejects the receipt",
  async (cut) => {
    const input = await suspend();
    const changed = structuredClone(input.subagent);
    if (cut === "run") {
      changed.taskRunId = "replacement-source-run";
    } else if (cut === "host incarnation") {
      bindSubagentRunRuntimeKey(changed, {});
      subagentRuns.set(changed.runId, changed);
    } else if (cut === "execution") {
      changed.endedReason = "subagent-killed";
      changed.execution.outcome = { status: "error", error: "cancelled by the requester" };
    } else if (cut === "delivery generation") {
      changed.delivery!.generation = 2;
    }
    const rejectWrite = cut === "registry write" || cut === "failed settlement write";
    if (cut !== "host incarnation" && !rejectWrite) {
      await mutateSubagentRuns(
        [changed.runId],
        () => ({ value: undefined, postimages: new Map([[changed.runId, changed]]) }),
        { runs: subagentRuns },
      );
    }
    if (rejectWrite) {
      db.value.db.exec(
        "CREATE TRIGGER reject_ack AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'ack write cut'); END",
      );
    }
    try {
      await expect(settle(input, cut !== "failed settlement write")).rejects.toThrow(
        rejectWrite ? "ack write cut" : /(owner|cohort) changed before mutation/,
      );
      expect(isDeliverySuspended(input.subagent)).toBe(true);
      expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
    } finally {
      if (rejectWrite) {
        db.value.db.exec("DROP TRIGGER reject_ack");
      }
    }
    db.value = await reopenCompletionFixtureOwners();
    const stored = currentCompletionRun(input);
    expect(isDeliverySuspended(stored)).toBe(true);
    expect(stored.requesterSettleWake).toBeDefined();
    if (cut === "delivery generation") {
      expect(stored.delivery).toMatchObject({ status: "suspended", generation: 2 });
    }
  },
);
