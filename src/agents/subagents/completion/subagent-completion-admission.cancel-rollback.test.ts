import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  mutateSubagentRuns,
} from "../registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  advanceRequesterWakeTime,
  armRequesterWake,
  records,
  requesterWakeDriver,
  admitCompletionFixtureDatabase,
  seedSubagentCompletionDelivery,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("requester wake cancellation rollback", () => {
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    const tempDir = tempDirs.make("openclaw-wake-cancel-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistOwner(input: ReturnType<typeof records>) {
    seedSubagentCompletionDelivery({
      subagent: input.subagent,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
  }

  it.each([
    { outcome: "delivered", owner: "current" },
    { outcome: "replay budget", owner: "current" },
    { outcome: "replay budget", owner: "replacement" },
    { outcome: "delivered", owner: "replacement" },
    { outcome: "delivered", owner: "rearm" },
  ] as const)(
    "preserves the known $outcome after a failed Stop with a $owner owner",
    async ({ outcome, owner }) => {
      vi.useFakeTimers();
      const input = records();
      const sibling = records();
      sibling.subagent.taskRunId = "task-run-cancel-sibling";
      sibling.subagent.runId = "cancel-sibling";
      sibling.subagent.childSessionKey = "agent:main:subagent:cancel-sibling";
      const inputs = [input, sibling];
      const batch = inputs.map(({ subagent }) => subagent);
      const batchRunIds = batch.map(({ runId }) => runId);
      for (const record of inputs) {
        armRequesterWake(record, batchRunIds);
        record.subagent.requesterSettleWake!.status = "dispatching";
        record.subagent.requesterSettleWake!.attemptCount = 1;
        persistOwner(record);
      }
      const original = structuredClone(input.subagent);
      const driver = requesterWakeDriver(inputs);
      const finalized = vi.fn();
      if (outcome === "delivered") {
        database.db.exec(
          "CREATE TRIGGER reject_delivered AFTER UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.delivery.status') = 'delivered' BEGIN SELECT RAISE(ABORT, 'cut:delivered'); END",
        );
      } else {
        database.db.exec(
          "CREATE TRIGGER reject_replay AFTER UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.requesterSettleWake.replayCount') = 1 BEGIN SELECT RAISE(ABORT, 'replay receipt write failed'); END",
        );
      }
      const replayStates: Array<typeof input.subagent.requesterSettleWake> = [];
      driver.wake.mockImplementation(async (params) => {
        if (driver.wake.mock.calls.length > 1) {
          replayStates.push(
            loadSubagentRegistryFromSqlite().get(params.settledEntry.runId)?.requesterSettleWake,
          );
          return false;
        }
        if (outcome === "delivered") {
          await params.completeBatch(
            batch,
            1,
            { delivered: true, path: "direct", requesterVisibleFinalDelivered: true },
            finalized,
          );
        } else {
          await params.transitionBatch(
            batch,
            {
              status: "dispatching",
              attemptCount: 1,
              replayCount: 1,
              nextAttemptAt: Date.now() + 30_000,
              batchRunIds,
              rearmGeneration: 1,
              lastError: "ambiguous transport",
            },
            () => {},
          );
        }
        return outcome === "delivered";
      });

      const writerEntered = createDeferredCore();
      const releaseWriter = createDeferredCore();
      const writeFailure = new SubagentRegistryWriteError(
        "not-committed",
        new Error("Stop write rejected"),
      );
      let stopHeld = false;
      probe.command(stateWorker, async (command, executeOptions, scope) => {
        if (command.type === "subagents.persistChanges" && !stopHeld) {
          stopHeld = true;
          writerEntered.resolve();
          await releaseWriter.promise;
          throw writeFailure;
        }
        return scope.execute(command, executeOptions);
      });
      let stopResult: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await driver.run();
        driver.controller.resumeRequesterSettleWake(sibling.subagent.runId, sibling.subagent);
        const retryAt = driver.controller.scheduledRequesterSettleWakeTimers.get(
          input.subagent.runId,
        )!.deadline;
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        stopResult = Promise.allSettled([
          driver.controller.cancelRequesterSettleWake(input.subagent, () => {}),
        ]);
        await writerEntered.promise;

        // Retry callbacks cannot publish a completion while Stop owns admission.
        // The sibling reconciles the shared pending commit through its real owner.
        await advanceRequesterWakeTime(retryAt - Date.now());
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (outcome === "delivered") {
          database.db.exec("DROP TRIGGER reject_delivered");
        } else {
          database.db.exec("DROP TRIGGER reject_replay");
        }

        let successor: typeof input.subagent | undefined;
        let successorWrite: Promise<void> | undefined;
        if (owner !== "current") {
          successor = structuredClone(original);
          successor.suppressCompletionDelivery = undefined;
          successor.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            batchRunIds: [successor.runId],
            nextAttemptAt: Date.now() + 300_000,
          };
          if (owner === "replacement") {
            successor.generation = (original.generation ?? 0) + 1;
          }
          const next = successor;
          successorWrite = mutateSubagentRuns([next.runId], () => ({
            value: undefined,
            postimages: new Map([[next.runId, next]]),
          }));
        }
        releaseWriter.resolve();
        expect(await stopResult).toEqual([{ status: "rejected", reason: writeFailure }]);
        await successorWrite;
        if (successor) {
          driver.controller.resumeRequesterSettleWake(
            successor.runId,
            subagentRuns.get(successor.runId)!,
          );
        }
        await advanceRequesterWakeTime(60_000);

        expect(driver.wake).toHaveBeenCalledTimes(outcome === "replay budget" ? 2 : 1);
        const stored = loadSubagentRegistryFromSqlite();
        if (owner === "current" && outcome === "delivered") {
          expect(finalized).toHaveBeenCalledOnce();
          for (const record of inputs) {
            expect(stored.get(record.subagent.runId)?.delivery?.status).toBe("delivered");
            expect(stored.get(record.subagent.runId)?.requesterSettleWake).toBeUndefined();
          }
        } else if (outcome === "replay budget") {
          expect(replayStates).toEqual([
            expect.objectContaining({
              status: "dispatching",
              attemptCount: 1,
              replayCount: 1,
              lastError: "ambiguous transport",
            }),
          ]);
          for (const record of owner === "current" ? inputs : [sibling]) {
            expect(stored.get(record.subagent.runId)?.requesterSettleWake).toMatchObject({
              status: "dispatching",
              attemptCount: 1,
              replayCount: 1,
              lastError: "ambiguous transport",
            });
          }
          if (owner === "replacement") {
            expect(subagentRuns.get(input.subagent.runId)?.generation).toBe(successor?.generation);
            expect(stored.get(input.subagent.runId)?.requesterSettleWake).toEqual(
              successor?.requesterSettleWake,
            );
            expect(stored.get(input.subagent.runId)?.delivery?.status).toBe("in_progress");
            expect(driver.wake.mock.calls[1]?.[0].settledEntry.runId).toBe(sibling.subagent.runId);
          }
        } else {
          expect(subagentRuns.get(input.subagent.runId)?.generation).toBe(successor?.generation);
          expect(stored.get(input.subagent.runId)?.requesterSettleWake).toEqual(
            successor?.requesterSettleWake,
          );
          expect(stored.get(input.subagent.runId)?.requesterSettleWake?.rearmGeneration).toBe(2);
          expect(stored.get(input.subagent.runId)?.delivery?.status).toBe("in_progress");
          expect(stored.get(sibling.subagent.runId)?.delivery?.status).toBe("delivered");
        }
        for (const record of inputs) {
          expect(stored.get(record.subagent.runId)?.execution.outcome?.status).toBe("ok");
          expect(stored.get(record.subagent.runId)?.completion?.resultText).toBe(
            "canonical result",
          );
        }
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_delivered");
        database.db.exec("DROP TRIGGER IF EXISTS reject_replay");
        releaseWriter.resolve();
        await stopResult;
        driver.controller.clearScheduledResumeTimers();
        await advanceRequesterWakeTime(0);
        vi.useRealTimers();
      }
    },
  );
});
