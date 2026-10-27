import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { resolveRequesterRecoveryDelivery } from "../announce/subagent-announce-completion-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  armRequesterWake,
  readCompletionSystemEvents,
  records,
  reopenCompletionFixtureOwners,
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

const db = useCompletionDatabase("openclaw-requester-outcome-");

it("retains a failed recovered requester without queuing another model input", async () => {
  const { subagent } = armRequesterWake(records());
  seedSubagentCompletionOwner({ subagent, databaseOptions: { database: db.value } });
  const completion = structuredClone(subagent.completion);
  const recovery = resolveRequesterRecoveryDelivery(
    {
      sessionId: "requester-session",
      updatedAt: Date.now(),
      restartRecoveryTerminalRunIds: ["recovered-requester"],
    },
    "recovered-requester",
  );
  assert(recovery?.kind === "delivery");

  await settleRequesterCompletionBatch({
    entries: [subagent],
    outcome: recovery.delivery,
    databaseOptions: { database: db.value },
  });

  db.value = await reopenCompletionFixtureOwners();
  const restored = subagentRuns.get(subagent.runId)!;
  expect(restored.completion).toEqual(completion);
  expect(restored.delivery).toMatchObject({
    status: "failed",
    disposition: "permanent_failure",
    lastError: "recovered requester completed without durable final delivery evidence",
  });
  expect(restored.requesterSettleWake).toBeUndefined();
  expect(readCompletionSystemEvents(db.value)).toEqual([]);
});

it("retains a failed completion without creating another parent input after publication fails", async () => {
  const { subagent } = armRequesterWake(records());
  seedSubagentCompletionOwner({ subagent, databaseOptions: { database: db.value } });
  let committed: RequesterWakeCommittedWrite | undefined;
  const settle = (onPublished: () => void) =>
    settleRequesterCompletionBatch({
      entries: [subagent],
      outcome: { delivered: false, path: "none", error: "Requester unavailable" },
      databaseOptions: { database: db.value },
      committed,
      onCommitted: (receipt) => {
        committed = receipt;
      },
      onPublished,
    });
  await expect(
    settle(() => {
      throw new Error("Synthetic publication observer failure");
    }),
  ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
  expect(readCompletionSystemEvents(db.value)).toEqual([]);
  expect(subagentRuns.get(subagent.runId)?.delivery).toMatchObject({
    status: "failed",
    lastError: "Requester unavailable",
  });
  db.value.db.exec(
    "CREATE TRIGGER reject_replay BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'outcome replayed'); END",
  );
  await expect(settle(() => {})).resolves.toEqual({ applied: true, publication: "published" });
  expect(readCompletionSystemEvents(db.value)).toEqual([]);
});
