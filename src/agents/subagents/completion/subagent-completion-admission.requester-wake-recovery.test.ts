import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
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
import { onSubagentRegistryPersisted } from "../registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { upsertSubagentRunRowInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("requester wake recovery after task expiry", () => {
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

  function expiredTaskOrphan(retainTask = false) {
    const input = armRequesterWake(records());
    const endedAt = Date.now() - 8 * 24 * 60 * 60_000;
    input.task.createdAt = endedAt - 1_000;
    input.task.endedAt = endedAt;
    input.task.lastEventAt = endedAt;
    input.subagent.createdAt = input.task.createdAt;
    input.subagent.execution.endedAt = endedAt;
    input.subagent.cleanupCompletedAt = endedAt;
    input.subagent.completion!.capturedAt = endedAt;
    input.subagent.delivery = { status: "pending", generation: 1 };
    persistOwner(input);
    if (!retainTask) {
      database.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(input.task.taskId);
    }
    reopenOwners();
    input.subagent = subagentRuns.get(input.subagent.runId)!;
    return input;
  }

  it("settles an expired task orphan durably after the requester wake fails", async () => {
    const input = expiredTaskOrphan();
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(input.subagent.delivery).toMatchObject({
        status: "failed",
        lastError: "requester unavailable",
      });
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("failed");
      expect(rowCount("task_runs")).toBe(0);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("retains an expired orphan wake when its SQLite settlement rolls back, then recovers after restart", async () => {
    const input = expiredTaskOrphan();
    database.db.exec(
      "CREATE TEMP TRIGGER reject_orphan_settlement BEFORE UPDATE ON subagent_runs " +
        "BEGIN SELECT RAISE(ABORT, 'orphan settlement unavailable'); END",
    );
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeDefined();
      expect(input.subagent.delivery?.status).toBe("pending");
      expect(
        loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
      ).toBeDefined();
      reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const resumed = requesterWakeDriver([input]);
      try {
        await resumed.run();
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        expect(input.subagent.delivery?.status).toBe("failed");
      } finally {
        resumed.controller.clearScheduledResumeTimers();
      }
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("retains an expired orphan wake when a newer child generation owns the session", async () => {
    const input = expiredTaskOrphan();
    const newer = structuredClone(input.subagent);
    newer.runId = "newer-child-run";
    newer.generation = (input.subagent.generation ?? 0) + 1;
    newer.createdAt += 1;
    newer.requesterSettleWake = undefined;
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(newer));
    subagentRuns.set(newer.runId, newer);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeDefined();
      expect(input.subagent.delivery?.status).toBe("pending");
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
      expect(subagentRuns.get(newer.runId)).toBeDefined();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("retains an expired orphan wake with a prior visible requester receipt", async () => {
    const input = expiredTaskOrphan();
    input.subagent.delivery!.requesterVisibleFinal = {
      requesterTurnRunId: "requester-turn",
      batchRunIds: [input.subagent.runId],
    };
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(input.subagent));
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeDefined();
      expect(input.subagent.delivery?.status).toBe("pending");
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.delivery?.requesterVisibleFinal).toEqual({
        requesterTurnRunId: "requester-turn",
        batchRunIds: [input.subagent.runId],
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("retains an old wake when task lookup is unavailable but its task row survives", async () => {
    const input = expiredTaskOrphan(true);
    const driver = requesterWakeDriver([input]);
    vi.spyOn(driver.controller.options, "resolveSubagentTask").mockReturnValue({
      lookup: "unavailable",
    });
    const retryPersisted = new Promise<void>((resolve) => {
      const unsubscribe = onSubagentRegistryPersisted(() => {
        unsubscribe();
        resolve();
      });
    });
    try {
      await driver.run();
      await retryPersisted;
      expect(input.subagent.requesterSettleWake).toMatchObject({ settleFailureCount: 1 });
      expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("session_queued");
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
      expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("session_queued");
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("cannot overwrite a newer durable wake when retrying a stale in-memory owner", async () => {
    const input = armRequesterWake(records());
    input.subagent.delivery = { status: "pending", generation: 1 };
    persistOwner(input);
    const newer = structuredClone(input.subagent);
    newer.requesterSettleWake!.rearmGeneration = 2;
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(newer));
    const driver = requesterWakeDriver([input]);
    const retryFinished = new Promise<void>((resolve) => {
      driver.warn.mockImplementation((message) => {
        if (
          message.startsWith("requester settle wake deferred") ||
          message === "failed to persist requester settle wake retry deadline"
        ) {
          resolve();
        }
      });
    });
    try {
      await driver.run();
      await retryFinished;
      expect(
        loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
      ).toMatchObject({
        rearmGeneration: 2,
      });
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toMatchObject({
        rearmGeneration: 2,
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it.each(["succeeded", "cancelled"] as const)(
    "persists bounded backoff for a retryable %s settlement error without losing the wake",
    async (status) => {
      const input =
        status === "succeeded"
          ? armRequesterWake(records())
          : failedRecords("cancelled", { status: "error" });
      input.subagent.delivery = { status: "pending", generation: 1 };
      persistOwner(input);
      database.db.exec(
        "CREATE TEMP TRIGGER reject_task_settlement BEFORE UPDATE ON task_runs " +
          "BEGIN SELECT RAISE(ABORT, 'temporary task write failure'); END",
      );
      let unsubscribe = () => {};
      const retryPersisted = new Promise<void>((resolve) => {
        unsubscribe = onSubagentRegistryPersisted(() => {
          unsubscribe();
          resolve();
        });
      });
      const driver = requesterWakeDriver([input]);
      try {
        await driver.run();
        await retryPersisted;
        const wake = input.subagent.requesterSettleWake;
        expect(wake).toMatchObject({ status: "pending", settleFailureCount: 1 });
        expect(wake?.nextAttemptAt).toBeGreaterThan(Date.now());
        expect(input.subagent.delivery?.status).toBe("pending");
        expect(
          loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
        ).toMatchObject({
          settleFailureCount: 1,
          nextAttemptAt: wake?.nextAttemptAt,
        });
        reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toMatchObject({
          status: "pending",
          settleFailureCount: 1,
          nextAttemptAt: wake?.nextAttemptAt,
        });
        expect(getTaskById(input.task.taskId)).toMatchObject({
          status: input.task.status,
          deliveryStatus: "session_queued",
        });
      } finally {
        unsubscribe();
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );
});
