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
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  bindSubagentRunRecord,
  loadSubagentRegistryFromSqlite,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.sqlite.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
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
