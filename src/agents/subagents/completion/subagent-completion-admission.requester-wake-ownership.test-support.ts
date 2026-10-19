import { expect, it } from "vitest";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";

export function registerRequesterWakeOwnershipTests({
  database: getDatabase,
  persistOwner,
}: {
  database: () => OpenClawStateDatabase;
  persistOwner: (input: ReturnType<typeof records>) => unknown;
}) {
  it.each(["owner", "incarnation"] as const)(
    "reconciles aged cancellation only with known child ownership (missing: %s)",
    (missing) => {
      const database = getDatabase();
      const input = failedRecords("cancelled", { status: "error", error: "stopped" });
      const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      input.subagent.killReconciliation = { killedAt: endedAt };
      if (missing === "owner") {
        input.subagent.childSessionKey = "global";
        input.subagent.childAgentId = undefined;
      } else {
        input.subagent.childSessionIdentity = undefined;
      }
      persistOwner(input);
      const before = loadSubagentRegistryFromSqlite().get(input.subagent.runId);

      const result = runOpenClawStateWriteTransaction(
        () =>
          mutateSubagentCompletionInDatabase(database, {
            kind: "reconcileCancelled",
            expected: input.subagent,
            now: Date.now(),
          }),
        { database },
      );

      const after = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
      if (missing === "owner") {
        expect(result.records).toEqual([]);
        expect(after).toEqual(before);
      } else {
        expect(result.records).toHaveLength(1);
        expect(after).toEqual({ ...before, killReconciliation: undefined });
        expect(after?.childSessionIdentity).toBeUndefined();
      }
    },
  );

  it.each([undefined, "requester-turn"])(
    "settles an explicitly owned raw-child wake with requester-turn retirement (%s)",
    async (requesterTurnRunId) => {
      const input = armRequesterWake(records());
      Object.assign(input.subagent, {
        childSessionKey: "global",
        childAgentId: "main",
        cleanupCompletedAt: undefined,
        requesterTurnRunId,
        retireAfterRequesterTurn: true,
      });
      input.subagent.requesterSettleWake!.retireAfterSettle = true;
      persistOwner(input);

      await expect(
        settleRequesterCompletionBatch({
          entries: [input.subagent],

          context: captureOpenClawStateWorkerContext(),
          assertCurrent: () => {},
          onCommitted: () => {},
          onPublished: () => {},
        }),
      ).resolves.toMatchObject({ applied: true, publication: "published" });

      const retained = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
      if (requesterTurnRunId) {
        expect(retained).toMatchObject({
          childSessionKey: "global",
          childAgentId: "main",
          requesterTurnRunId,
          retireAfterRequesterTurn: true,
        });
        expect(retained?.requesterSettleWake).toBeUndefined();
        expect(retained?.browserCleanupDispatchedAt).toBeUndefined();
        expect(retained?.cleanupCompletedAt).toBeUndefined();
      } else {
        expect(retained).toBeUndefined();
      }
    },
  );
}
