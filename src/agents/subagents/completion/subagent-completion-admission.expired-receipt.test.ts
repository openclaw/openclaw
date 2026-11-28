import { expect, it, vi } from "vitest";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { bindSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  currentCompletionRun,
  armRequesterWake,
  reopenCompletionFixtureOwners,
  records,
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const db = useCompletionDatabase("openclaw-expired-receipt-");

function pendingCompletion() {
  const input = armRequesterWake(records());
  input.subagent.cleanupHandled = false;
  input.subagent.cleanupCompletedAt = undefined;
  input.subagent.delivery = { status: "pending", generation: 1 };
  seedSubagentCompletionOwner({ ...input, databaseOptions: { database: db.value } });
  return input;
}

function settle(input: ReturnType<typeof records>, delivered: boolean) {
  return settleRequesterCompletionBatch({
    entries: [input.subagent],
    outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
    assertCurrent: () => {},
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
  "run",
  "execution",
  "host incarnation",
  "delivery generation",
  "registry write",
  "failed settlement write",
] as const)("preserves the pending delivery and wake when %s rejects the receipt", async (cut) => {
  const input = pendingCompletion();
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
    expect(input.subagent.delivery?.status).toBe("pending");
    expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
  } finally {
    if (rejectWrite) {
      db.value.db.exec("DROP TRIGGER reject_ack");
    }
  }
  db.value = await reopenCompletionFixtureOwners();
  const stored = currentCompletionRun(input);
  expect(stored.delivery?.status).toBe("pending");
  expect(stored.requesterSettleWake).toBeDefined();
  if (cut === "delivery generation") {
    expect(stored.delivery).toMatchObject({ status: "pending", generation: 2 });
  }
});
