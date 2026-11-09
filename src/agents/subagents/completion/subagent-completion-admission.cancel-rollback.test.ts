import { expect, it, vi } from "vitest";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  mutateSubagentRuns,
} from "../registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  advanceRequesterWakeTime,
  armRequesterWake,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const db = useCompletionDatabase("openclaw-wake-cancel-", vi.restoreAllMocks);

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
      seedSubagentCompletionOwner({ ...record, databaseOptions: { database: db.value } });
    }
    const original = structuredClone(input.subagent);
    const delivered = outcome === "delivered";
    const driver = requesterWakeDriver(inputs);
    const resumeSibling = (entry = sibling.subagent) =>
      driver.controller.resumeRequesterSettleWake(entry.runId, entry);
    const finalized = vi.fn();
    const replay = {
      status: "dispatching" as const,
      attemptCount: 1,
      replayCount: 1,
      lastError: "ambiguous transport",
    };
    const trigger = delivered ? "reject_delivered" : "reject_replay";
    const condition = delivered
      ? "json_extract(NEW.payload_json, '$.delivery.status') = 'delivered'"
      : "json_extract(NEW.payload_json, '$.requesterSettleWake.replayCount') = 1";
    const error = delivered ? "cut:delivered" : "replay receipt write failed";
    db.value.db.exec(
      `CREATE TRIGGER ${trigger} AFTER UPDATE ON subagent_runs WHEN ${condition} BEGIN SELECT RAISE(ABORT, '${error}'); END`,
    );
    const replayStates: Array<typeof input.subagent.requesterSettleWake> = [];
    driver.wake.mockImplementation(async (params) => {
      if (driver.wake.mock.calls.length > 1) {
        replayStates.push(
          loadSubagentRegistryFromSqlite().get(params.settledEntry.runId)?.requesterSettleWake,
        );
        return false;
      }
      if (delivered) {
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
            ...replay,
            nextAttemptAt: Date.now() + 30_000,
            batchRunIds,
            rearmGeneration: 1,
          },
          () => {},
        );
      }
      return delivered;
    });

    const writerEntered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const failure = new SubagentRegistryWriteError("not-committed", new Error("Stop rejected"));
    let stopHeld = false;
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "subagents.persistChanges" && !stopHeld) {
        stopHeld = true;
        writerEntered.resolve();
        await releaseWriter.promise;
        throw failure;
      }
      return scope.execute(command, executeOptions);
    });
    let stopResult: Promise<PromiseSettledResult<void>[]> | undefined;
    const settleRootWork = observeRootWork();
    try {
      await driver.run();
      resumeSibling();
      expect(driver.wake).toHaveBeenCalledOnce();
      expect(finalized).not.toHaveBeenCalled();
      stopResult = Promise.allSettled([
        driver.controller.retireSubagentObligations(input.subagent, () => {}, {
          requesterNotified: true,
        }),
      ]);
      await writerEntered.promise;

      resumeSibling();
      expect(driver.wake).toHaveBeenCalledOnce();
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery?.status).toBe(
        "in_progress",
      );
      db.value.db.exec(`DROP TRIGGER ${trigger}`);

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
      expect(await stopResult).toEqual([{ status: "rejected", reason: failure }]);
      await successorWrite;
      await advanceRequesterWakeTime(60_000, () =>
        resumeSibling(subagentRuns.get(sibling.subagent.runId)!),
      );
      await settleRootWork(true);

      expect(driver.wake).toHaveBeenCalledTimes(outcome === "replay budget" ? 2 : 1);
      const stored = loadSubagentRegistryFromSqlite();
      const storedInput = stored.get(input.subagent.runId);
      if (owner !== "current") {
        expect(subagentRuns.get(input.subagent.runId)?.generation).toBe(successor?.generation);
        expect(storedInput?.requesterSettleWake).toEqual(successor?.requesterSettleWake);
        expect(storedInput?.delivery?.status).toBe("in_progress");
      }
      if (owner === "current" && delivered) {
        expect(finalized).toHaveBeenCalledOnce();
        for (const record of inputs) {
          expect(stored.get(record.subagent.runId)?.delivery?.status).toBe("delivered");
          expect(stored.get(record.subagent.runId)?.requesterSettleWake).toBeUndefined();
        }
      } else if (outcome === "replay budget") {
        expect(replayStates).toEqual([expect.objectContaining(replay)]);
        for (const record of owner === "current" ? inputs : [sibling]) {
          expect(stored.get(record.subagent.runId)?.requesterSettleWake).toMatchObject(replay);
        }
        if (owner === "replacement") {
          expect(driver.wake.mock.calls[1]?.[0].settledEntry.runId).toBe(sibling.subagent.runId);
        }
      } else {
        expect(storedInput?.requesterSettleWake?.rearmGeneration).toBe(2);
        expect(stored.get(sibling.subagent.runId)?.delivery?.status).toBe("delivered");
      }
      for (const record of inputs) {
        expect(stored.get(record.subagent.runId)).toMatchObject({
          execution: { outcome: { status: "ok" } },
          completion: { resultText: "canonical result" },
        });
      }
    } finally {
      db.value.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      releaseWriter.resolve();
      await stopResult;
      await settleRootWork();
      driver.controller.clearRuntimeState();
      await advanceRequesterWakeTime(0);
      vi.useRealTimers();
    }
  },
);
