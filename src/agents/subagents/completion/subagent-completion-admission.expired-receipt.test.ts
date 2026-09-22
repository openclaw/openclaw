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
import { isDeliverySuspended } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("requester receipts after completion expiry", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-expired-receipt-", resolvePreferredOpenClawTmpDir()),
    );
    database = openOpenClawStateDatabase();
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function suspend(
    options: {
      completionTarget?: "parent";
      reason?: "expiry" | "permanent_failure";
      resultText?: string | null;
    } = {},
  ) {
    const input = armRequesterWake(records());
    input.subagent.cleanupHandled = false;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.completionTarget = options.completionTarget;
    input.subagent.completionRequesterSessionId = options.completionTarget
      ? "requester-session"
      : undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    if (options.resultText !== undefined) {
      input.subagent.completion!.resultText = options.resultText;
    }
    input.task.notifyPolicy = "silent";
    input.task.deliveryStatus = "pending";
    input.task.parentFlowId = "requester-flow";
    settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    upsertTaskFlowRegistryRecordToSqlite({
      flowId: input.task.parentFlowId,
      syncMode: "task_mirrored",
      ownerKey: input.task.ownerKey,
      goal: input.task.task,
      revision: 1,
      status: "running",
      notifyPolicy: "silent",
      createdAt: input.task.createdAt,
      updatedAt: input.task.createdAt,
    });
    expect(getTaskFlowById(input.task.parentFlowId)?.status).toBe("running");
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "completion delivery expired",
        suspendedReason: options.reason ?? "expiry",
        databaseOptions: { database },
      }),
    ).toBe(true);
    expect(isDeliverySuspended(input.subagent)).toBe(true);
    expect(getTaskFlowById(input.task.parentFlowId)?.status).toBe("blocked");
    return input;
  }

  function settle(input: ReturnType<typeof records>, delivered: boolean) {
    settleRequesterCompletionBatch({
      entries: [{ subagent: input.subagent, taskId: input.task.taskId }],
      outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
      isCurrent: () => true,
      databaseOptions: { database },
    });
  }

  function reopen() {
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  it("retains an admitted cleanup lock while publishing the requester receipt", () => {
    const input = armRequesterWake(records());
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    input.task.deliveryStatus = "pending";
    settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);

    settle(input, true);

    expect(subagentRuns.get(input.subagent.runId)).toBe(input.subagent);
    expect(input.subagent.cleanupHandled).toBe(true);
    expect(input.subagent.cleanupCompletedAt).toBeUndefined();
    expect(input.subagent.requesterSettleWake).toBeUndefined();
    expect(input.subagent.delivery?.status).toBe("delivered");
    reopen();
    // Process-local custody cannot survive a restart without durable completion.
    expect(subagentRuns.get(input.subagent.runId)?.cleanupHandled).toBe(false);
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
  });

  it.each([undefined, "parent"] as const)(
    "records a successful requester wake after expiry (target=%s)",
    async (completionTarget) => {
      const input = suspend({ completionTarget });
      const cleanupAfter = getTaskById(input.task.taskId)?.cleanupAfter;
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        return true;
      });
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(isDeliverySuspended(input.subagent)).toBe(false);
        reopen();
        const stored = subagentRuns.get(input.subagent.runId);
        expect(stored?.delivery?.status).toBe("delivered");
        expect(stored?.delivery?.suspendedAt).toBeUndefined();
        expect(stored?.delivery?.suspendedReason).toBeUndefined();
        expect(stored?.delivery?.lastError).toBeUndefined();
        expect(stored?.delivery?.payload).toBeUndefined();
        expect(stored?.requesterSettleWake).toBeUndefined();
        expect(stored?.completion?.resultText).toBe("canonical result");
        const task = getTaskById(input.task.taskId);
        expect(task).toMatchObject({
          status: "succeeded",
          deliveryStatus: "delivered",
          cleanupAfter,
        });
        expect(task?.error).toBeUndefined();
        expect(task?.terminalOutcome).not.toBe("blocked");
        expect(task?.terminalSummary).toBeUndefined();
        expect(getTaskFlowById(input.task.parentFlowId!)?.status).toBe("succeeded");
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it("preserves a missing-deliverable verdict after its delivery is acknowledged", () => {
    const input = suspend({ completionTarget: "parent", resultText: null });
    settle(input, true);
    reopen();
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
    expect(getTaskById(input.task.taskId)).toMatchObject({
      status: "succeeded",
      deliveryStatus: "delivered",
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });
    expect(getTaskById(input.task.taskId)?.error).toBeUndefined();
    expect(getTaskFlowById(input.task.parentFlowId!)?.status).toBe("blocked");
  });

  it.each([
    { reason: "expiry" as const, delivered: false },
    { reason: "permanent_failure" as const, delivered: true },
  ])("does not recover $reason without an eligible successful receipt", ({ reason, delivered }) => {
    const input = suspend({ reason });
    settle(input, delivered);
    reopen();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
    expect(getTaskById(input.task.taskId)).toMatchObject({
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
  });

  it("rejects an acknowledgment after the durable delivery generation changes", () => {
    const input = suspend();
    const changed = structuredClone(input.subagent);
    changed.delivery!.generation = 2;
    settleSubagentCompletionDelivery({
      subagent: changed,
      task: getTaskById(input.task.taskId)!,
      databaseOptions: { database },
    });
    expect(() => settle(input, true)).toThrow("owner changed before settlement");
    reopen();
    expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
      status: "suspended",
      generation: 2,
    });
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
  });

  it.each(["run", "execution"] as const)("rejects a changed task %s owner", (changedOwner) => {
    const input = suspend();
    const task = { ...getTaskById(input.task.taskId)! };
    if (changedOwner === "run") {
      task.runId = "replacement-task-run";
    } else {
      task.status = "cancelled";
      task.error = "cancelled by the requester";
    }
    settleSubagentCompletionDelivery({
      subagent: input.subagent,
      task,
      databaseOptions: { database },
    });
    expect(() => settle(input, true)).toThrow("owner changed before settlement");
    reopen();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
    expect(getTaskById(input.task.taskId)?.status).toBe(task.status);
  });

  it("rolls back task, delivery, and wake changes together if the registry write fails", () => {
    const input = suspend();
    database.db.exec(
      "CREATE TEMP TRIGGER reject_ack AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'ack write cut'); END",
    );
    expect(() => settle(input, true)).toThrow("ack write cut");
    expect(isDeliverySuspended(input.subagent)).toBe(true);
    expect(input.subagent.requesterSettleWake).toBeDefined();
    reopen();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
    expect(getTaskById(input.task.taskId)).toMatchObject({
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
  });
});
