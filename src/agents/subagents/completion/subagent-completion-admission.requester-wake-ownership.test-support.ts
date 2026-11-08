import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { mutateRequesterCompletionBatch } from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  failedRecords,
  records,
} from "./subagent-completion-admission.test-helpers.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

export function registerRequesterWakeOwnershipTests({
  database: getDatabase,
  persistOwner,
}: {
  database: () => OpenClawStateDatabase;
  persistOwner: (input: ReturnType<typeof records>) => unknown;
}) {
  it("reconciles an acknowledged retirement without even a no-op data write", async () => {
    const database = getDatabase();
    const input = armRequesterWake(records());
    input.subagent.expectsCompletionMessage = false;
    input.subagent.delivery = { status: "not_required" };
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    persistOwner(input);
    let committed: RequesterWakeCommittedWrite | undefined;
    await expect(
      mutateRequesterCompletionBatch({
        entries: [input.subagent],
        operation: { kind: "complete" },
        context: captureOpenClawStateWorkerContext(),
        assertCurrent() {
          if (subagentRuns.get(input.subagent.runId) !== input.subagent) {
            throw new Error("Retirement lost its exact registered owner");
          }
        },
        onCommitted: (receipt) => {
          committed = receipt;
        },
        onPublished: () => {},
      }),
    ).resolves.toEqual({ applied: true, publication: "published" });
    if (!committed) {
      throw new Error("Retirement did not return its native receipt");
    }
    const receipt = committed;
    expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
    runOpenClawStateWriteTransaction(
      () => {
        const sql = observeHostDataSql();
        try {
          const result = mutateSubagentCompletionInDatabase(database, {
            kind: "requesterWake",
            entries: receipt.entries,
            operation: { kind: "complete" },
            committed: receipt,
          });
          expect(result).toMatchObject({ applied: true, retiredRunIds: [input.subagent.runId] });
          const isSelectedRead = (query: string) =>
            /^\s*select\b/i.test(query) && query.includes("subagent_runs");
          const selectedPreparations = sql.calls[0]!.mock.calls.filter(
            ([query]) => typeof query === "string" && isSelectedRead(query),
          ).length;
          // Count actual executions beyond prepares of these same SELECTs, including cached reads.
          expect(sql.queries.filter(isSelectedRead).length).toBeGreaterThan(selectedPreparations);
          expect(
            sql.queries.filter((query) => /^\s*(?:insert|update|delete)\b/i.test(query)),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      },
      { database, path: database.path },
    );
    expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
  });

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
        mutateRequesterCompletionBatch({
          entries: [input.subagent],
          operation: { kind: "complete" },
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
