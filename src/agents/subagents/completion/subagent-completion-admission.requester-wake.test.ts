import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { getTaskFlowById } from "../../../tasks/task-flow-registry.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../../../tasks/task-flow-registry.store.sqlite.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../registry/subagent-registry-state.js";
import { upsertSubagentRunRowInDatabase } from "../registry/subagent-registry.store.kernel.js";
import {
  bindSubagentRunRecord,
  loadSubagentRegistryFromSqlite,
} from "../registry/subagent-registry.store.sqlite.js";
import {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("persisted subagent requester wakes", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-subagent-wake-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
  });

  afterEach(() => {
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

  function systemEvents() {
    return database.db
      .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
      .all();
  }

  function rowCount(table: "task_runs"): number {
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  function reopenOwners() {
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  it.each([true, false])(
    "keeps active cleanup unless requester delivery is blocked (delivered=%s)",
    (delivered) => {
      const input = armRequesterWake(records());
      input.subagent.cleanupCompletedAt = undefined;
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const generation = driver.controller.bumpCleanupGeneration(input.subagent);

      settleRequesterCompletionBatch({
        entries: [{ subagent: input.subagent, taskId: input.task.taskId }],
        outcome: {
          delivered,
          path: "direct",
          error: delivered ? undefined : "requester unavailable",
        },
        isCurrent: () => true,
        databaseOptions: { database },
      });

      expect(
        driver.controller.isCleanupAttemptCurrent(input.subagent.runId, input.subagent, generation),
      ).toBe(delivered);
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.cleanupHandled).toBe(
        false,
      );
    },
  );

  it("settles a rejected dispatch transition after rollback without another wake", async () => {
    const input = armRequesterWake(records());
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    vi.spyOn(driver.controller.options, "persistOrThrow").mockImplementationOnce(() => {
      throw new Error("dispatch write failed");
    });
    driver.wake.mockImplementation(async (params) => {
      params.transitionBatch([input.subagent], {
        status: "dispatching",
        attemptCount: 1,
        rearmGeneration: 1,
      });
      throw new Error("transport must not start");
    });
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(input.subagent.delivery).toMatchObject({
        status: "failed",
        lastError: "dispatch write failed",
      });
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(driver.wake).toHaveBeenCalledOnce();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it.each([true, false])(
    "publishes the mirrored parent flow before requester settlement observers (delivered=%s)",
    async (delivered) => {
      const input = armRequesterWake(records());
      const flowId = "requester-parent-flow";
      input.task.parentFlowId = flowId;
      persistOwner(input);
      upsertTaskFlowRegistryRecordToSqlite({
        flowId,
        syncMode: "task_mirrored",
        ownerKey: input.task.ownerKey,
        goal: "Unfinished parent flow",
        revision: 4,
        status: "running",
        notifyPolicy: input.task.notifyPolicy,
        createdAt: input.task.createdAt,
        updatedAt: input.task.createdAt,
      });
      resetTaskFlowRegistryForTests({ persist: false });
      database = openOpenClawStateDatabase();
      expect(getTaskFlowById(flowId)).toMatchObject({ status: "running", revision: 4 });

      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch([input.subagent], 1, {
          delivered,
          path: "direct",
          error: delivered ? undefined : "requester unavailable",
        });
        return delivered;
      });
      const observed = vi.fn(() => ({
        inTransaction: database.db.isTransaction,
        task: getTaskById(input.task.taskId),
        flow: getTaskFlowById(flowId),
      }));
      const unsubscribe = onSubagentRegistryPersisted(observed);
      const expectedTask = {
        status: "succeeded",
        terminalOutcome: delivered ? "succeeded" : "blocked",
        deliveryStatus: delivered ? "delivered" : "failed",
      };
      const expectedFlow = {
        flowId,
        revision: 5,
        status: delivered ? "succeeded" : "blocked",
        goal: input.task.task,
        blockedTaskId: delivered ? undefined : input.task.taskId,
      };
      try {
        await driver.run();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.results[0]?.value).toMatchObject({
          inTransaction: false,
          task: expectedTask,
          flow: expectedFlow,
        });
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        resetTaskFlowRegistryForTests({ persist: false });
        reopenOwners();
        expect(getTaskById(input.task.taskId)).toMatchObject(expectedTask);
        expect(getTaskFlowById(flowId)).toMatchObject(expectedFlow);
        expect(systemEvents()).toHaveLength(delivered ? 0 : 1);
      } finally {
        unsubscribe();
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["second owner", "second task write", "retirement"] as const)(
    "commits the entire requester batch or nothing when %s refuses settlement",
    async (cut) => {
      const first = records();
      const second = records();
      second.task.taskId = "task-second";
      second.task.runId = "task-run-second";
      second.subagent.runId = "completion-second";
      second.subagent.taskRunId = second.task.runId;
      second.subagent.childSessionKey = second.task.childSessionKey = "agent:main:subagent:second";
      const inputs = [first, second];
      const ids = inputs.map(({ subagent }) => subagent.runId);
      for (const input of inputs) {
        armRequesterWake(input, ids);
        if (cut === "retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        persistOwner(input);
      }
      const liveBefore = inputs.map(({ subagent }) => structuredClone(subagent));
      if (cut === "second owner") {
        const changed = structuredClone(second);
        changed.task.runId = "replacement-task-owner";
        settleSubagentCompletionDelivery({ ...changed, databaseOptions: { database } });
      } else {
        database.db.exec(
          cut === "second task write"
            ? "CREATE TEMP TRIGGER reject_batch AFTER UPDATE ON task_runs WHEN NEW.task_id = 'task-second' BEGIN SELECT RAISE(ABORT, 'cut:second'); END"
            : "CREATE TEMP TRIGGER reject_batch AFTER DELETE ON subagent_runs WHEN OLD.run_id = 'completion-second' BEGIN SELECT RAISE(ABORT, 'cut:retirement'); END",
        );
      }
      const snapshot = () =>
        ["subagent_runs", "task_runs", "delivery_queue_entries"].map((table) =>
          database.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(),
        );
      const before = snapshot();
      const driver = requesterWakeDriver(inputs);
      let settle:
        | Parameters<typeof driver.controller.options.maybeWakeRequesterAfterAllChildrenSettled>[0]
        | undefined;
      driver.wake.mockImplementation(async (params) => {
        settle = params;
        return false;
      });
      const observed = vi.fn(() =>
        inputs.map(({ subagent }) =>
          structuredClone(subagentRuns.get(subagent.runId)?.requesterSettleWake),
        ),
      );
      const unsubscribe = onSubagentRegistryPersisted(observed);
      try {
        await driver.run();
        expect(() =>
          settle!.completeBatch(
            inputs.map(({ subagent }) => subagent),
            1,
            {
              delivered: false,
              path: "none",
              error: "requester unavailable",
            },
          ),
        ).toThrow();
        expect(inputs.map(({ subagent }) => subagent)).toEqual(liveBefore);
        expect(snapshot()).toEqual(before);
        expect(observed).not.toHaveBeenCalled();
        reopenOwners();
        expect(snapshot()).toEqual(before);
        for (const [index, input] of inputs.entries()) {
          input.subagent = subagentRuns.get(input.subagent.runId)!;
          if (cut === "second owner" && index === 1) {
            persistOwner(input);
          }
        }
        const retry = requesterWakeDriver(inputs);
        try {
          await retry.run();
          expect(observed).toHaveBeenCalledOnce();
          expect(observed.mock.results[0]?.value).toEqual([undefined, undefined]);
          expect(systemEvents()).toHaveLength(2);
          reopenOwners();
          for (const input of inputs) {
            expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
            expect(subagentRuns.has(input.subagent.runId)).toBe(cut !== "retirement");
            expect(getTaskById(input.task.taskId)).toMatchObject({
              status: "succeeded",
              terminalOutcome: "blocked",
              deliveryStatus: "failed",
            });
          }
        } finally {
          retry.controller.clearScheduledResumeTimers();
        }
      } finally {
        unsubscribe();
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each([false, true])(
    "reconciles failed replay persistence before transport (sibling rearmed: %s)",
    async (rearmSibling) => {
      vi.useFakeTimers();
      const input = armRequesterWake(records());
      const sibling = armRequesterWake(records());
      sibling.task.taskId = "task-replay-sibling";
      sibling.task.runId = "task-run-replay-sibling";
      sibling.subagent.runId = "replay-sibling";
      sibling.subagent.taskRunId = sibling.task.runId;
      sibling.subagent.childSessionKey = sibling.task.childSessionKey =
        "agent:main:subagent:replay-sibling";
      const inputs = rearmSibling ? [input, sibling] : [input];
      const batch = inputs.map(({ subagent }) => subagent);
      const batchRunIds = batch.map(({ runId }) => runId);
      for (const record of inputs) {
        armRequesterWake(record, batchRunIds);
        persistOwner(record);
      }
      const driver = requesterWakeDriver(inputs);
      const persist = driver.controller.options.persistOrThrow.bind(driver.controller.options);
      let unavailable = true;
      let writes = 0;
      driver.controller.options.persistOrThrow = (...ids) => {
        if (input.subagent.requesterSettleWake?.replayCount) {
          writes++;
          if (unavailable) {
            throw new Error("replay persistence unavailable");
          }
        }
        persist(...ids);
      };
      const transport = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        const state = input.subagent.requesterSettleWake!;
        if (state.status !== "dispatching") {
          params.transitionBatch(batch, {
            status: "dispatching",
            attemptCount: 1,
            rearmGeneration: 1,
            batchRunIds,
          });
        }
        transport();
        if (transport.mock.calls.length === 1) {
          params.transitionBatch(batch, {
            status: "dispatching",
            attemptCount: 1,
            replayCount: 1,
            nextAttemptAt: Date.now() + 30_000,
            rearmGeneration: 1,
            batchRunIds,
            lastError: "ambiguous transport",
          });
        } else {
          expect(state).toMatchObject({ status: "dispatching", attemptCount: 1, replayCount: 1 });
          params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        }
        return false;
      });
      try {
        await driver.run();
        if (rearmSibling) {
          sibling.subagent.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            nextAttemptAt: Date.now() + 600_000,
          };
          persist(sibling.subagent.runId);
        }
        for (let sweep = 0; sweep < 6; sweep++) {
          driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(writes).toBe(2);
        for (let sweep = 0; sweep < 6; sweep++) {
          driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(writes).toBe(2);
        unavailable = false;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(writes).toBe(3);
        expect(transport).toHaveBeenCalledOnce();
        driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
        await vi.advanceTimersByTimeAsync(0);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        expect(input.subagent.delivery?.status).toBe("delivered");
        if (rearmSibling) {
          expect(sibling.subagent.requesterSettleWake).toMatchObject({
            attemptCount: 0,
            rearmGeneration: 2,
          });
        }
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["current", "replacement", "rearm"] as const)(
    "retains a known delivered outcome without redelivery or overwriting a %s owner",
    async (owner) => {
      vi.useFakeTimers();
      const input = armRequesterWake(records());
      input.subagent.requesterSettleWake!.status = "dispatching";
      input.subagent.requesterSettleWake!.attemptCount = 1;
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const finalized = vi.fn();
      database.db.exec(
        "CREATE TEMP TRIGGER reject_delivered AFTER UPDATE ON task_runs BEGIN SELECT RAISE(ABORT, 'cut:delivered'); END",
      );
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch(
          [input.subagent],
          1,
          {
            delivered: true,
            path: "direct",
            requesterVisibleFinalDelivered: true,
          },
          finalized,
        );
        return true;
      });
      try {
        await driver.run();
        expect(input.subagent.delivery?.status).toBe("in_progress");
        expect(finalized).not.toHaveBeenCalled();
        for (let sweep = 0; sweep < 6; sweep++) {
          driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(driver.wake).toHaveBeenCalledOnce();
        database.db.exec("DROP TRIGGER reject_delivered");
        if (owner === "replacement") {
          const replacement = structuredClone(input.subagent);
          subagentRuns.set(replacement.runId, replacement);
        } else if (owner === "rearm") {
          input.subagent.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
          };
          driver.controller.options.persistOrThrow(input.subagent.runId);
        }
        // The next persistence deadline is independent of the failed durable write.
        await vi.advanceTimersByTimeAsync(60_000);
        if (owner === "current") {
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(finalized).toHaveBeenCalledOnce();
          expect(input.subagent.requesterSettleWake).toBeUndefined();
          reopenOwners();
          expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("delivered");
        } else {
          expect(finalized).not.toHaveBeenCalled();
          expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("in_progress");
          if (owner === "rearm") {
            expect(input.subagent.requesterSettleWake?.rearmGeneration).toBe(2);
          }
        }
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["in_progress", "delivered"] as const)(
    "replaces a %s completion receipt on requester settlement and clears pending payloads",
    async (status) => {
      const input = armRequesterWake(records());
      const receipt = input.subagent.delivery!;
      receipt.status = status;
      if (status === "in_progress") {
        receipt.payload = loadPendingFinalDeliveryPayload(input.subagent);
        receipt.attemptCount = 2;
      } else {
        receipt.deliveredAt = receipt.announcedAt = Date.now();
        input.task.deliveryStatus = "delivered";
      }
      const before = structuredClone(receipt);
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        return true;
      });
      try {
        await driver.run();
        expect(input.subagent.delivery).not.toBe(receipt);
        expect(input.subagent.delivery?.status).toBe("delivered");
        expect(input.subagent.delivery?.payload).toBeUndefined();
        expect(input.subagent.delivery?.attemptCount).toBeUndefined();
        expect(receipt).toEqual(before);
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
          status: "delivered",
        });
        expect(subagentRuns.get(input.subagent.runId)?.delivery?.payload).toBeUndefined();
        expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("delivered");
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each([
    { change: "rearmed", delivered: true },
    { change: "retired", delivered: true },
    { change: "replaced", delivered: true },
    { change: "not yet durable", delivered: true },
    { change: "blocked", delivered: true },
    { change: "blocked retirement", delivered: true },
    { change: "blocked newer wave", delivered: true },
    { change: "rearmed", delivered: false },
    { change: "retired", delivered: false },
  ] as const)(
    "retains the known outcome for unchanged siblings when one member is $change (delivered=$delivered)",
    async ({ change, delivered }) => {
      vi.useFakeTimers();
      const first = records();
      const second = records();
      second.task.taskId = "task-second";
      second.task.runId = "task-run-second";
      second.subagent.runId = "completion-second";
      second.subagent.taskRunId = second.task.runId;
      second.subagent.childSessionKey = second.task.childSessionKey = "agent:main:subagent:second";
      const third = records();
      third.task.taskId = "task-third";
      third.task.runId = "task-run-third";
      third.subagent.runId = "completion-third";
      third.subagent.taskRunId = third.task.runId;
      third.subagent.childSessionKey = third.task.childSessionKey = "agent:main:subagent:third";
      const inputs = [first, second, third];
      const ids = inputs.map(({ subagent }) => subagent.runId);
      for (const input of inputs) {
        armRequesterWake(input, ids);
        if (input === second && change === "blocked retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        input.subagent.requesterSettleWake!.status = "dispatching";
        input.subagent.requesterSettleWake!.attemptCount = 1;
        persistOwner(input);
      }
      const driver = requesterWakeDriver(inputs);
      const finalized = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch(
          inputs.map(({ subagent }) => subagent),
          1,
          {
            delivered,
            path: "direct",
            requesterVisibleFinalDelivered: delivered ? true : undefined,
            error: delivered ? undefined : "requester unavailable",
          },
          finalized,
        );
        return true;
      });
      database.db.exec(
        "CREATE TEMP TRIGGER reject_outcome AFTER UPDATE ON task_runs BEGIN SELECT RAISE(ABORT, 'cut:outcome'); END",
      );
      try {
        await driver.run();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        database.db.exec("DROP TRIGGER reject_outcome");
        const blocked = change.startsWith("blocked");
        if (blocked) {
          expect(
            blockSubagentCompletionDelivery({
              subagent: second.subagent,
              taskId: second.task.taskId,
              reason: "B was independently closed",
              databaseOptions: { database },
            }),
          ).toBe(true);
          expect(second.subagent.requesterSettleWake?.rearmGeneration).toBe(1);
        }
        const secondTaskBeforeRetry = structuredClone(getTaskById(second.task.taskId));
        let successor = second.subagent;
        if (change === "retired") {
          subagentRuns.delete(second.subagent.runId);
          driver.controller.options.persistOrThrow(second.subagent.runId);
        } else if (!blocked || change === "blocked newer wave") {
          if (change === "replaced") {
            successor = structuredClone(second.subagent);
            successor.generation = (successor.generation ?? 0) + 1;
            subagentRuns.set(successor.runId, successor);
          }
          successor.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            batchRunIds: [successor.runId],
            nextAttemptAt: Date.now() + 600_000,
          };
          if (change !== "not yet durable") {
            driver.controller.options.persistOrThrow(successor.runId);
          }
        }
        const newerWake = structuredClone(successor.requesterSettleWake);
        driver.controller.resumeRequesterSettleWake(first.subagent.runId, first.subagent);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(driver.wake).toHaveBeenCalledOnce();
        if (change === "not yet durable") {
          // The store still sees B as an old-cohort owner: retain A's fence rather
          // than omitting B or treating refusal as permission for another send.
          expect(first.subagent.requesterSettleWake).toBeDefined();
          expect(first.subagent.delivery?.status).toBe("in_progress");
          expect(finalized).not.toHaveBeenCalled();
          driver.controller.options.persistOrThrow(successor.runId);
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(driver.wake).toHaveBeenCalledOnce();
        for (const input of [first, third]) {
          expect(input.subagent.requesterSettleWake).toBeUndefined();
          expect(input.subagent.delivery?.status).toBe(delivered ? "delivered" : "failed");
          expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe(
            delivered ? "delivered" : "failed",
          );
        }
        expect(getTaskById(second.task.taskId)).toEqual(secondTaskBeforeRetry);
        expect(getTaskById(second.task.taskId)?.deliveryStatus).toBe(
          blocked ? "failed" : "session_queued",
        );
        expect(finalized).toHaveBeenCalledOnce();
        if (change !== "retired" && change !== "blocked retirement") {
          expect(subagentRuns.get(successor.runId)).toBe(successor);
          expect(successor.requesterSettleWake).toEqual(
            change === "blocked" ? undefined : newerWake,
          );
          expect(successor.delivery?.status).toBe(blocked ? "failed" : "in_progress");
        } else {
          expect(subagentRuns.has(second.subagent.runId)).toBe(false);
        }
        reopenOwners();
        for (const input of [first, third]) {
          expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
          expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe(
            delivered ? "delivered" : "failed",
          );
        }
        expect(subagentRuns.get(second.subagent.runId)?.requesterSettleWake).toEqual(
          ["retired", "blocked", "blocked retirement"].includes(change) ? undefined : newerWake,
        );
        expect(getTaskById(second.task.taskId)).toEqual(secondTaskBeforeRetry);
        expect(systemEvents()).toHaveLength((blocked ? 1 : 0) + (delivered ? 0 : 2));
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { status: "failed", outcome: { status: "error" } },
    { status: "timed_out", outcome: { status: "timeout" } },
  ] as const)(
    "settles an uncaptured $status wake without inventing reply capture",
    async ({ status, outcome }) => {
      const input = failedRecords(status, outcome);
      input.subagent.completion = { required: true };
      persistOwner(input);
      const before = structuredClone(input);
      const driver = requesterWakeDriver([input]);
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
        reopenOwners();
        const restored = subagentRuns.get(input.subagent.runId)!;
        expect(restored.requesterSettleWake).toBeUndefined();
        expect(restored.execution).toEqual(before.subagent.execution);
        expect(restored.completion).toEqual(before.subagent.completion);
        expect(getTaskById(input.task.taskId)).toMatchObject({
          ...before.task,
          deliveryStatus: "failed",
          lastEventAt: expect.any(Number),
        });
        expect(systemEvents()).toEqual([]);
        expect(driver.wake).toHaveBeenCalledOnce();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["missing outcome", "paused", "mismatched task", "superseded generation"] as const)(
    "does not settle uncaptured completion with %s evidence",
    (change) => {
      const input = failedRecords("failed", { status: "error" });
      input.subagent.completion = { required: true };
      if (change === "missing outcome") {
        input.subagent.execution.outcome = undefined;
      } else if (change === "paused") {
        input.subagent.pauseReason = "sessions_yield";
      } else if (change === "mismatched task") {
        input.task.status = "timed_out";
      }
      persistOwner(input);
      const before = structuredClone(input);
      if (change === "superseded generation") {
        before.subagent.delivery!.generation = 2;
        upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(before.subagent));
      }
      expect(
        blockSubagentCompletionDelivery({
          subagent: input.subagent,
          taskId: input.task.taskId,
          reason: "requester unavailable",
        }),
      ).toBe(false);
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(getTaskById(input.task.taskId)).toMatchObject(before.task);
      expect(systemEvents()).toEqual([]);
    },
  );

  it.each([
    { delivered: false, retireAfterSettle: false },
    { delivered: false, retireAfterSettle: true },
    { delivered: true, retireAfterSettle: false },
    { delivered: true, retireAfterSettle: true },
  ])(
    "settles a yielded requester wake without completing the paused task (delivered=$delivered, retire=$retireAfterSettle)",
    async ({ delivered, retireAfterSettle }) => {
      const input = armRequesterWake(records());
      input.task.status = "running";
      delete input.task.endedAt;
      delete input.task.terminalOutcome;
      input.task.deliveryStatus = "pending";
      input.subagent.pauseReason = "sessions_yield";
      input.subagent.execution.outcome = undefined;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      input.subagent.cleanupCompletedAt = undefined;
      input.subagent.cleanupHandled = false;
      input.subagent.requesterSettleWake!.retireAfterSettle = retireAfterSettle;
      persistOwner(input);
      const before = structuredClone(input);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch([params.settledEntry], 1, {
          delivered,
          path: "direct",
          error: delivered ? undefined : "requester unavailable",
        });
        return delivered;
      });
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
        reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)).toEqual({
          ...before.subagent,
          requesterSettleWake: undefined,
        });
        expect(getTaskById(input.task.taskId)).toMatchObject(before.task);
        expect(systemEvents()).toEqual([]);
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["unchanged", "newer sibling", "task returned", "run generation", "wake generation"])(
    "reconciles a retired cancellation wake only with its current owner: %s",
    async (change) => {
      const input = failedRecords("cancelled", { status: "error", error: "stopped" });
      const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      persistOwner(input);
      database.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(input.task.taskId);
      reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const before = structuredClone(input.subagent);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async () => {
        if (change === "task returned") {
          settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
        } else if (change !== "unchanged") {
          const updated = structuredClone(input.subagent);
          if (change === "newer sibling") {
            updated.runId = "newer-child-run";
            updated.generation = (updated.generation ?? 0) + 1;
          } else if (change === "run generation") {
            updated.generation = (updated.generation ?? 0) + 1;
          } else {
            updated.requesterSettleWake!.rearmGeneration = 2;
          }
          upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(updated));
        }
        throw new Error("requester unavailable");
      });
      try {
        await driver.run();
        if (change === "unchanged") {
          expect(driver.warn).not.toHaveBeenCalledWith(
            "failed to persist requester settle wake rejection",
            expect.any(Object),
          );
        } else {
          expect(driver.warn).toHaveBeenCalledWith(
            "failed to persist requester settle wake rejection",
            expect.any(Object),
          );
        }
        reopenOwners();
        const restored = subagentRuns.get(input.subagent.runId)!;
        expect(restored.execution).toEqual(before.execution);
        expect(restored.cleanupCompletedAt).toBe(endedAt);
        if (change === "unchanged") {
          expect(restored.requesterSettleWake).toBeUndefined();
          expect(restored.completion).toEqual({
            required: true,
            resultText: null,
            capturedAt: endedAt,
          });
          expect(restored.delivery).toMatchObject({
            status: "failed",
            lastError: "requester unavailable",
          });
          expect(restored.suppressCompletionDelivery).toBe(true);
        } else {
          expect(restored.requesterSettleWake).toBeDefined();
          expect(restored.completion).toEqual(before.completion);
          expect(restored.delivery).toEqual(before.delivery);
        }
        expect(rowCount("task_runs")).toBe(change === "task returned" ? 1 : 0);
        expect(systemEvents()).toEqual([]);
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );
});
