import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import * as registryState from "../registry/subagent-registry-state.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));
vi.mock("../registry/subagent-registry-state.js", { spy: true });

describe("requester wake cancellation rollback", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-wake-cancel-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistOwner(input: ReturnType<typeof records>) {
    settleSubagentCompletionDelivery({
      subagent: input.subagent,
      task: input.task,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
  }

  it.each([
    { outcome: "delivered", owner: "current" },
    { outcome: "replay budget", owner: "current" },
    { outcome: "delivered", owner: "replacement" },
    { outcome: "delivered", owner: "rearm" },
  ] as const)(
    "preserves the known $outcome after a failed Stop with a $owner owner",
    async ({ outcome, owner }) => {
      vi.useFakeTimers();
      const input = records();
      const sibling = records();
      sibling.task.taskId = "task-cancel-sibling";
      sibling.task.runId = sibling.subagent.taskRunId = "task-run-cancel-sibling";
      sibling.subagent.runId = "cancel-sibling";
      sibling.subagent.childSessionKey = sibling.task.childSessionKey =
        "agent:main:subagent:cancel-sibling";
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
      let rejectReplayWrite = outcome === "replay budget";
      driver.controller.options.persistOrThrow = (...ids) => {
        if (
          rejectReplayWrite &&
          ids.some((id) => subagentRuns.get(id)?.requesterSettleWake?.replayCount === 1)
        ) {
          throw new Error("replay receipt write failed");
        }
        // A sibling write must not persist another member's staged cancellation.
        registryState.persistSubagentRunsToDiskOrThrow(subagentRuns, ids);
      };
      if (outcome === "delivered") {
        database.db.exec(
          "CREATE TEMP TRIGGER reject_delivered AFTER UPDATE ON task_runs BEGIN SELECT RAISE(ABORT, 'cut:delivered'); END",
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
          params.completeBatch(
            batch,
            1,
            { delivered: true, path: "direct", requesterVisibleFinalDelivered: true },
            finalized,
          );
        } else {
          params.transitionBatch(batch, {
            status: "dispatching",
            attemptCount: 1,
            replayCount: 1,
            nextAttemptAt: Date.now() + 30_000,
            batchRunIds,
            rearmGeneration: 1,
            lastError: "ambiguous transport",
          });
        }
        return outcome === "delivered";
      });

      const writerEntered = createDeferredCore();
      const releaseWriter = createDeferredCore();
      const writeFailure = new SubagentRegistryWriteError(
        "not-committed",
        new Error("Stop write rejected"),
      );
      vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementationOnce(
        async () => {
          writerEntered.resolve();
          await releaseWriter.promise;
          throw writeFailure;
        },
      );
      let stopResult: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await driver.run();
        driver.controller.resumeRequesterSettleWake(sibling.subagent.runId, sibling.subagent);
        const retryAt = driver.controller.getRequesterSettleWakeTimer(
          input.subagent.runId,
        )!.deadline;
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        stopResult = Promise.allSettled([
          driver.controller.cancelRequesterSettleWake(input.subagent, () => {}),
        ]);
        await writerEntered.promise;

        // Both native retry callbacks run while Stop has only staged its write.
        // The sibling reconciles the shared pending commit through its real owner.
        await vi.advanceTimersByTimeAsync(retryAt - Date.now());
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        rejectReplayWrite = false;
        if (outcome === "delivered") {
          database.db.exec("DROP TRIGGER reject_delivered");
        }

        let successor: typeof input.subagent | undefined;
        if (owner !== "current") {
          successor = owner === "replacement" ? structuredClone(original) : input.subagent;
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
          subagentRuns.set(successor.runId, successor);
          driver.controller.options.persistOrThrow(successor.runId);
          driver.controller.resumeRequesterSettleWake(successor.runId, successor);
        }
        releaseWriter.resolve();
        expect(await stopResult).toEqual([{ status: "rejected", reason: writeFailure }]);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(driver.wake).toHaveBeenCalledTimes(outcome === "replay budget" ? 2 : 1);
        const stored = loadSubagentRegistryFromSqlite();
        if (owner === "current" && outcome === "delivered") {
          expect(finalized).toHaveBeenCalledOnce();
          for (const record of inputs) {
            expect(getTaskById(record.task.taskId)?.deliveryStatus).toBe("delivered");
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
          for (const record of inputs) {
            expect(stored.get(record.subagent.runId)?.requesterSettleWake).toMatchObject({
              status: "dispatching",
              attemptCount: 1,
              replayCount: 1,
              lastError: "ambiguous transport",
            });
          }
        } else {
          expect(subagentRuns.get(input.subagent.runId)).toBe(successor);
          expect(stored.get(input.subagent.runId)?.requesterSettleWake).toEqual(
            successor?.requesterSettleWake,
          );
          expect(stored.get(input.subagent.runId)?.requesterSettleWake?.rearmGeneration).toBe(2);
          expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("session_queued");
          expect(getTaskById(sibling.task.taskId)?.deliveryStatus).toBe("delivered");
        }
        for (const record of inputs) {
          expect(getTaskById(record.task.taskId)?.status).toBe("succeeded");
          expect(stored.get(record.subagent.runId)?.completion?.resultText).toBe(
            "canonical result",
          );
        }
      } finally {
        releaseWriter.resolve();
        await stopResult;
        driver.controller.clearScheduledResumeTimers();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );
});
