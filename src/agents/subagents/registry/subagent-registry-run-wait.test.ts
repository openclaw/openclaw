import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";

function storedPayload(runId: string): string | undefined {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "subagent_runs">>(db)
      .selectFrom("subagent_runs")
      .select("payload_json")
      .where("run_id", "=", runId),
  ).rows[0]?.payload_json;
}

it.each(["live", "closing"] as const)(
  "settles failed completion recovery with a %s state database",
  async (lifecycle) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      await f.change((draft) => {
        draft.execution = { status: "terminal", startedAt: 1, endedAt: 2 };
        draft.cleanupHandled = true;
      });
      const original = f.current();
      const before = structuredClone(original);
      const persisted = storedPayload(original.runId);
      expect(original.cleanupHandled).toBe(true);
      expect(persisted).toBeTypeOf("string");
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockRejectedValue(new Error("synthetic timing read failed"));
      const write = f.holdNextWrite("before");
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(write.entered, waiting, "Recovery did not reach its write");
        if (lifecycle === "closing") {
          closing = closeOpenClawStateDatabaseAsync();
          expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        }
        write.release();
        await expect(waiting).resolves.toBeUndefined();
        await closing;
        if (lifecycle === "live") {
          expect(f.current().cleanupHandled).toBe(false);
          expect(f.options.resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(original.runId);
        } else {
          expect(storedPayload(original.runId)).toBe(persisted);
          expect(f.current()).toEqual(before);
          expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
          expect(f.options.scheduleSweep).not.toHaveBeenCalled();
        }
      } finally {
        write.release();
        await Promise.allSettled([waiting, ...(closing ? [closing] : [])]);
        timing.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "retires a closed wait without hiding an unknown outcome (%s)",
  async (unknown) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const original = f.current();
      const before = structuredClone(original);
      const entered = createDeferred();
      const release = createDeferred();
      const fault = new SqliteWorkerError("synthetic unknown write outcome", "outcome-unknown");
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (unknown) {
            throw fault;
          }
          return undefined;
        });
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          waiting,
          "Wait did not reach reconciliation",
        );
        await closeOpenClawStateDatabaseAsync();
        release.resolve();
        if (unknown) {
          await expect(waiting).rejects.toBe(fault);
        } else {
          await expect(waiting).resolves.toBeUndefined();
        }
        expect(f.current()).toEqual(before);
        expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
        expect(f.options.scheduleSweep).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([waiting]);
        timing.mockRestore();
      }
    });
  },
);
