import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  finalizeSubagentTaskRunForOwner,
  setSubagentTaskDeliveryStatusForOwner,
} from "../../../tasks/detached-task-runtime.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { runTaskInFlowForOwner } from "../../../tasks/task-executor.js";
import { createManagedTaskFlow } from "../../../tasks/task-flow-runtime-internal.js";
import {
  getTaskActivitySnapshot,
  recordTaskActivityEvent,
} from "../../../tasks/task-registry-activity.js";
import { updateTask } from "../../../tasks/task-registry-mutation.js";
import {
  findTaskByRunId,
  getTaskById,
  publishTaskRecordAfterAtomicStore,
  reloadTaskRegistryFromStore,
} from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-state.js";
import { registerSubagentRun, resumeSubagentRun } from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

describe("subagent task backing storage", () => {
  const env = captureEnv([
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE",
  ]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-task-backing-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    setTestEnvValue("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
      })}\n`,
    );
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetGatewayWorkAdmission();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      callGateway: async <T>() => ({ status: "pending" }) as T,
    });
  });

  afterEach(async () => {
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetDetachedTaskLifecycleRuntimeForTests();
    testing.setDepsForTest();
    resetGatewayWorkAdmission();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    closeOpenClawStateDatabaseForTest();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  function registerPreparedCollector(runId: string, expectsCompletionMessage = false) {
    registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "atomic collector acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "atomic-acceptance",
      queued: true,
      taskRowOwnership: "required",
      expectsCompletionMessage,
    });
    return findTaskByRunId(runId)!;
  }

  function createManagedProjection(runId: string) {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/collector-projection",
      goal: "Track collector projection",
    });
    if (!flow) {
      throw new Error("managed flow was not created");
    }
    const projected = runTaskInFlowForOwner({
      flowId: flow.flowId,
      callerOwnerKey: "agent:main:main",
      runtime: "subagent",
      childSessionKey: `agent:main:subagent:${runId}`,
      runId,
      task: "managed collector projection",
      status: "running",
    });
    if (!projected.created || !projected.task) {
      throw new Error(projected.reason ?? "managed projection was not created");
    }
    return projected.task;
  }

  it.each([
    { status: "succeeded" as const, error: undefined },
    { status: "cancelled" as const, error: "Cancelled by operator." },
  ])("updates canonical and managed projection on $status", ({ status, error }) => {
    const runId = `managed-${status}`;
    const canonical = registerPreparedCollector(runId, true);
    const projection = createManagedProjection(runId);

    const updated = finalizeSubagentTaskRunForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: `agent:main:subagent:${runId}`,
      generation: 1,
      status,
      endedAt: 500,
      lastEventAt: 500,
      error,
    });

    expect(updated.map((task) => task.taskId).toSorted()).toEqual(
      [canonical.taskId, projection.taskId].toSorted(),
    );
    for (const taskId of [canonical.taskId, projection.taskId]) {
      expect(getTaskById(taskId)).toMatchObject({ status, endedAt: 500 });
      expect(loadTaskRegistryStateFromSqlite().tasks.get(taskId)).toMatchObject({
        status,
        endedAt: 500,
      });
    }
  });

  it("does not mutate a managed projection when canonical terminal precedence rejects completion", () => {
    const runId = "managed-stable-cancellation";
    const canonical = registerPreparedCollector(runId, true);
    const projection = createManagedProjection(runId);
    updateTask(canonical.taskId, {
      status: "cancelled",
      error: "Cancelled by operator.",
      endedAt: 500,
      lastEventAt: 500,
    });

    expect(
      finalizeSubagentTaskRunForOwner({
        runId,
        ownerKey: "agent:main:main",
        sessionKey: `agent:main:subagent:${runId}`,
        generation: 1,
        status: "succeeded",
        endedAt: 600,
        lastEventAt: 600,
      }),
    ).toEqual([]);

    expect(getTaskById(canonical.taskId)).toMatchObject({
      status: "cancelled",
      endedAt: 500,
    });
    expect(getTaskById(projection.taskId)?.status).toBe("running");
    expect(getTaskById(projection.taskId)?.endedAt).toBeUndefined();
  });

  it("updates delivery only for canonical and authorized managed projections", () => {
    const runId = "managed-delivery";
    const canonical = registerPreparedCollector(runId, true);
    const projection = createManagedProjection(runId);
    const foreign = createManagedProjection(runId);
    updateTask(foreign.taskId, {
      detail: {
        kind: "task_backing_instance",
        runtime: "subagent",
        generation: 1,
        taskId: "foreign-canonical-task",
      },
    });

    const updated = setSubagentTaskDeliveryStatusForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: `agent:main:subagent:${runId}`,
      generation: 1,
      deliveryStatus: "delivered",
    });

    expect(updated.map((task) => task.taskId).toSorted()).toEqual(
      [canonical.taskId, projection.taskId].toSorted(),
    );
    expect(getTaskById(canonical.taskId)?.deliveryStatus).toBe("delivered");
    expect(getTaskById(projection.taskId)?.deliveryStatus).toBe("delivered");
    expect(getTaskById(foreign.taskId)?.deliveryStatus).toBe("pending");
  });

  it("rolls back canonical completion when an authorized projection write fails", () => {
    const runId = "managed-projection-write-fault";
    const canonical = registerPreparedCollector(runId, true);
    const projection = createManagedProjection(runId);
    const database = openOpenClawStateDatabase();
    database.db.exec("CREATE TEMP TABLE fail_task_update (task_id TEXT PRIMARY KEY)");
    database.db.prepare("INSERT INTO fail_task_update (task_id) VALUES (?)").run(projection.taskId);
    database.db.exec(`
      CREATE TEMP TRIGGER fail_authorized_projection_update
      BEFORE UPDATE ON task_runs
      WHEN EXISTS (SELECT 1 FROM fail_task_update WHERE task_id = OLD.task_id)
      BEGIN
        SELECT RAISE(ABORT, 'injected authorized projection failure');
      END
    `);

    expect(() =>
      finalizeSubagentTaskRunForOwner({
        runId,
        ownerKey: "agent:main:main",
        sessionKey: `agent:main:subagent:${runId}`,
        generation: 1,
        status: "succeeded",
        endedAt: 500,
        lastEventAt: 500,
      }),
    ).toThrow("injected authorized projection failure");

    expect(getTaskById(canonical.taskId)?.status).toBe("queued");
    expect(getTaskById(projection.taskId)?.status).toBe("running");
    expect(loadTaskRegistryStateFromSqlite().tasks.get(canonical.taskId)?.status).toBe("queued");
    expect(loadTaskRegistryStateFromSqlite().tasks.get(projection.taskId)?.status).toBe("running");
  });

  it("preserves terminal rejection projection across two cold restores", () => {
    const runId = "terminal-rejection-replay";
    const task = registerPreparedCollector(runId);
    finalizeSubagentTaskRunForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: `agent:main:subagent:${runId}`,
      generation: 1,
      status: "succeeded",
      endedAt: 400,
      lastEventAt: 410,
      terminalSummary: "completed before rejection",
    });
    expect(testing.failQueuedSubagentRun(runId, "collector dispatch rejected")).toBe(true);
    const entry = subagentRuns.get(runId)!;
    entry.collectorLaunchCleanupPending = false;
    entry.cleanupCompletedAt = 450;
    saveSubagentRegistryToSqlite(subagentRuns);
    const expected = loadTaskRegistryStateFromSqlite().tasks.get(task.taskId);

    for (let restore = 0; restore < 2; restore += 1) {
      closeOpenClawStateDatabaseForTest();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      restoreSubagentRunsFromDisk({ runs: subagentRuns });
      reloadTaskRegistryFromStore();
      resumeSubagentRun(runId, "restore");

      expect(subagentRuns.get(runId)?.taskTerminalProjection).toBe("preserve_existing");
      expect(getTaskById(task.taskId)).toEqual(expected);
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(expected);
    }
  });

  it("rejects mismatched backing through delivery, expiry, and cleanup", () => {
    const runId = "delivery-owner-mismatch";
    const canonical = registerPreparedCollector(runId, true);
    const projection = createManagedProjection(runId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE task_runs SET owner_key = ? WHERE task_id = ?")
      .run("agent:main:newer-owner", canonical.taskId);
    publishTaskRecordAfterAtomicStore({
      ...canonical,
      ownerKey: "agent:main:newer-owner",
    });

    for (const deliveryStatus of ["delivered", "failed", "pending"] as const) {
      expect(
        setSubagentTaskDeliveryStatusForOwner({
          runId,
          ownerKey: "agent:main:main",
          sessionKey: `agent:main:subagent:${runId}`,
          generation: 1,
          deliveryStatus,
          error: deliveryStatus === "failed" ? "expiry" : undefined,
        }),
      ).toEqual([]);
    }

    expect(loadTaskRegistryStateFromSqlite().tasks.get(canonical.taskId)).toMatchObject({
      ownerKey: "agent:main:newer-owner",
      deliveryStatus: "pending",
    });
    expect(loadTaskRegistryStateFromSqlite().tasks.get(projection.taskId)).toMatchObject({
      deliveryStatus: "pending",
      status: "running",
    });
  });

  it("publishes terminal cache before dirty activity can mutate reopened SQLite", () => {
    const runId = "dirty-activity-terminal";
    const task = registerPreparedCollector(runId);
    recordTaskActivityEvent(task, {
      runId,
      sessionKey: task.childSessionKey,
      seq: 1,
      ts: Date.now(),
      stream: "assistant",
      data: { delta: "working before completion" },
    });
    let staleActivityReentries = 0;
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (
            event.kind === "upserted" &&
            event.task.taskId === task.taskId &&
            event.task.status === "queued"
          ) {
            staleActivityReentries += 1;
            updateTask(task.taskId, {
              progressSummary: "stale activity observer mutation",
              lastEventAt: 490,
            });
          }
        },
      },
    });

    finalizeSubagentTaskRunForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: task.childSessionKey!,
      generation: 1,
      status: "succeeded",
      endedAt: 500,
      lastEventAt: 500,
    });
    const expected = getTaskById(task.taskId);
    closeOpenClawStateDatabaseForTest();
    resetTaskRegistryForTests({ persist: false });
    reloadTaskRegistryFromStore();

    expect(staleActivityReentries).toBe(0);
    expect(getTaskActivitySnapshot(task.taskId)).toBeUndefined();
    expect(getTaskById(task.taskId)).toEqual(expected);
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(expected);
  });

  it("preserves reentrant successor activity after atomic terminal publication", () => {
    const runId = "atomic-dirty-activity";
    const task = registerPreparedCollector(runId);
    updateTask(task.taskId, { status: "running", startedAt: 100, lastEventAt: 100 });
    const running = getTaskById(task.taskId)!;
    recordTaskActivityEvent(running, {
      runId,
      sessionKey: running.childSessionKey,
      seq: 1,
      ts: 110,
      stream: "assistant",
      data: { text: "atomic old owner activity" },
    });
    let replaced = false;
    const observedTasks: Array<Omit<TaskRecord, "detail">> = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (
            replaced ||
            event.kind !== "upserted" ||
            event.task.taskId !== task.taskId ||
            event.task.runId !== runId ||
            event.task.status !== "running"
          ) {
            return;
          }
          observedTasks.push(event.task);
          replaced = true;
          updateTask(task.taskId, {
            detail: createSubagentTaskBackingDetail(2),
            status: "running",
            startedAt: 120,
            lastEventAt: 120,
            endedAt: undefined,
            cleanupAfter: undefined,
          });
          const successor = getTaskById(task.taskId)!;
          recordTaskActivityEvent(successor, {
            runId,
            sessionKey: successor.childSessionKey,
            seq: 2,
            ts: 121,
            stream: "assistant",
            data: { text: "atomic successor activity" },
          });
        },
      },
    });

    finalizeSubagentTaskRunForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: task.childSessionKey!,
      generation: 1,
      status: "succeeded",
      endedAt: 130,
      lastEventAt: 130,
    });

    expect(replaced).toBe(true);
    expect(observedTasks).toHaveLength(1);
    expect(observedTasks[0]).not.toHaveProperty("detail");
    expect(getTaskById(task.taskId)?.detail).toEqual(createSubagentTaskBackingDetail(2));
    expect(getTaskActivitySnapshot(task.taskId)?.lastActivity).toBe("atomic successor activity");
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.detail).toEqual(
      createSubagentTaskBackingDetail(2),
    );
  });

  it("clears already-flushed activity after atomic terminal publication", async () => {
    const runId = "atomic-flushed-activity";
    const task = registerPreparedCollector(runId);
    updateTask(task.taskId, { status: "running", startedAt: 100, lastEventAt: 100 });
    const running = getTaskById(task.taskId)!;
    vi.useFakeTimers();
    try {
      recordTaskActivityEvent(running, {
        runId,
        sessionKey: running.childSessionKey,
        seq: 1,
        ts: 110,
        stream: "assistant",
        data: { text: "already flushed atomic activity" },
      });
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    finalizeSubagentTaskRunForOwner({
      runId,
      ownerKey: "agent:main:main",
      sessionKey: task.childSessionKey!,
      generation: 1,
      status: "succeeded",
      endedAt: 130,
      lastEventAt: 130,
    });

    expect(getTaskActivitySnapshot(task.taskId)).toBeUndefined();
  });
});
