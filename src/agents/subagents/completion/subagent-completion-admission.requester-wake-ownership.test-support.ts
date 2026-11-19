import { expect, it } from "vitest";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";

export function registerRequesterWakeOwnershipTests(options: {
  database: () => OpenClawStateDatabase;
  persistOwner: (input: ReturnType<typeof records>) => unknown;
}) {
  const stored = (input: ReturnType<typeof records>) =>
    loadSubagentRegistryFromSqlite().get(input.subagent.runId);
  it.each(["owner", "incarnation"] as const)(
    "reconciles aged cancellation only with known child ownership (missing: %s)",
    (missing) => {
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
      options.persistOwner(input);
      const before = stored(input);
      const database = options.database();
      const mutation = {
        kind: "reconcileCancelled" as const,
        expected: input.subagent,
        now: Date.now(),
      };
      const result = runOpenClawStateWriteTransaction(
        () => mutateSubagentCompletionInDatabase(database, mutation),
        { database },
      );
      const after = stored(input);
      expect(result.records).toHaveLength(missing === "owner" ? 0 : 1);
      expect(after).toEqual(
        missing === "owner" ? before : { ...before, killReconciliation: undefined },
      );
    },
  );

  it.each([undefined, "requester-turn"])(
    "settles an explicitly owned raw-child wake with requester-turn retirement (%s)",
    async (requesterTurnRunId) => {
      const input = armRequesterWake(records());
      const owner = {
        childSessionKey: "global",
        childAgentId: "main",
        cleanupCompletedAt: undefined,
        requesterTurnRunId,
        retireAfterRequesterTurn: true,
      };
      Object.assign(input.subagent, owner);
      input.subagent.requesterSettleWake!.retireAfterSettle = true;
      options.persistOwner(input);

      await expect(
        settleRequesterCompletionBatch({ entries: [input.subagent] }),
      ).resolves.toMatchObject({
        applied: true,
        publication: "published",
      });

      const retained = stored(input);
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
