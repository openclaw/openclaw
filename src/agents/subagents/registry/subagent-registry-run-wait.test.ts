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
import * as persistence from "./subagent-registry-persistence.js";
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
      expect(persisted).toBeTypeOf("string");
      const write = f.holdNextWrite("before");
      const writesBefore = f.writes;
      const recoveryQueued = createDeferred();
      const mutate = persistence.mutateSubagentRuns;
      let recovering = false;
      let predecessor: Promise<void> | undefined;
      const mutation = vi.spyOn(persistence, "mutateSubagentRuns").mockImplementation((...args) => {
        const pending = mutate(...args);
        if (recovering) {
          recoveryQueued.resolve();
        }
        return pending;
      });
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockImplementation(async () => {
          // cleanupHandled is runtime-only; queue recovery behind an actual durable change.
          predecessor = f.change((draft) => {
            draft.label = "queued before recovery";
          });
          await awaitGateBeforeSettlement(write.entered, predecessor, "Predecessor did not write");
          recovering = true;
          throw new Error("synthetic timing read failed");
        });
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          recoveryQueued.promise,
          waiting,
          "Recovery did not reserve its mutation",
        );
        if (lifecycle === "closing") {
          closing = closeOpenClawStateDatabaseAsync();
          expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        }
        write.release();
        await expect(waiting).resolves.toBeUndefined();
        await closing;
        expect(f.writes).toBe(writesBefore + 1);
        if (lifecycle === "live") {
          await predecessor;
          expect(f.current()).toMatchObject({
            cleanupHandled: false,
            label: "queued before recovery",
          });
          expect(f.stored()?.cleanupHandled).toBe(false);
          expect(f.options.resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(original.runId);
        } else {
          expect(storedPayload(original.runId)).toBe(persisted);
          expect(f.current()).toEqual(before);
          expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
          expect(f.options.scheduleSweep).not.toHaveBeenCalled();
        }
      } finally {
        write.release();
        await Promise.allSettled([waiting, predecessor, closing]);
        timing.mockRestore();
        mutation.mockRestore();
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
