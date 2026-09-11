import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import {
  deleteTaskRecordById,
  findTaskByRunId,
  publishTaskRecordAfterAtomicStore,
} from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { spawnSubagentDirect } from "../spawn/subagent-spawn.js";
import { testing as subagentSpawnTesting } from "../spawn/subagent-spawn.test-support.js";
import { reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { useQueuedCollectorAcceptanceStorageFixture } from "./subagent-registry-run-launch.sqlite.test-support.js";
import {
  getSubagentRunsSnapshotForRead,
  onSubagentRegistryPersisted,
} from "./subagent-registry-state.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { createSubagentRegistryTestDeps } from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  readSubagentRun,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

describe("queued collector acceptance storage", () => {
  const { externalCliClient, makeGatewayContext, registerPreparedCollector } =
    useQueuedCollectorAcceptanceStorageFixture();

  it("returns a live default receipt that rejects exact task and registry replacements", () => {
    const runId = "default-dispatch-receipt";
    expect(
      reserveSwarmRun({
        groupId: "dispatch-receipt",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
      }),
    ).toBe(true);
    const receipt = registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "prove exact default authority",
      cleanup: "keep",
      collect: true,
      groupId: "dispatch-receipt",
      queued: true,
      taskRowOwnership: "required",
    });
    expect(receipt?.kind).toBe("owned");
    expect(subagentRuns.get(runId)?.taskOwnershipPolicy).toBe("core_required");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.taskOwnershipPolicy).toBe("core_required");
    receipt?.assertDispatchCurrent();

    const task = findTaskByRunId(runId)!;
    publishTaskRecordAfterAtomicStore({ ...task });
    expect(() => receipt?.assertDispatchCurrent()).toThrow("ownership changed");

    const current = subagentRuns.get(runId)!;
    subagentRuns.set(runId, structuredClone(current));
    expect(() => receipt?.assertDispatchCurrent()).toThrow("ownership changed");
  });

  it("rejects a duplicate live run before replacing its canonical owner", () => {
    const runId = "duplicate-live-owner";
    registerPreparedCollector(runId);
    const owner = subagentRuns.get(runId)!;
    const persisted = readSubagentRun(openOpenClawStateDatabase(), runId);

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:duplicate-live-replacement",
        requesterSessionKey: "agent:main:other",
        requesterDisplayKey: "other",
        task: "changed duplicate metadata",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("already owned");

    expect(subagentRuns.get(runId)).toBe(owner);
    expect(readSubagentRun(openOpenClawStateDatabase(), runId)).toEqual(persisted);
    expect(findTaskByRunId(runId)?.task).toBe("atomic collector acceptance");
  });

  it("rejects a cold collector identity claimed by a mirrored accepted row", () => {
    const reservedRunId = "duplicate-mirrored-reserved";
    const acceptedRunId = "duplicate-mirrored-accepted";
    registerPreparedCollector(reservedRunId);
    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    resetSubagentRegistryForTests({ persist: false });

    expect(() =>
      registerSubagentRun({
        runId: reservedRunId,
        childSessionKey: "agent:main:subagent:duplicate-mirrored-replacement",
        requesterSessionKey: "agent:main:other",
        requesterDisplayKey: "other",
        task: "reuse a reserved collector identity",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("already owned");

    expect(readSubagentRun(openOpenClawStateDatabase(), acceptedRunId)).toMatchObject({
      swarmRunId: reservedRunId,
      taskRunId: reservedRunId,
      execution: { status: "running" },
    });
  });

  it("rejects changed task metadata that reuses a foreign canonical run identity", () => {
    const runId = "duplicate-foreign-task";
    const taskRuntime = getDetachedTaskLifecycleRuntime();
    const task = taskRuntime.createQueuedTaskRun({
      runtime: "subagent",
      sourceId: runId,
      requesterSessionKey: "agent:main:foreign",
      ownerKey: "agent:main:foreign",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:foreign",
      runId,
      task: "foreign task",
      deliveryStatus: "pending",
      detail: { kind: "foreign" },
    });
    expect(task).not.toBeNull();

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:replacement",
        requesterSessionKey: "agent:main:replacement",
        requesterDisplayKey: "replacement",
        task: "changed task metadata",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("already owned");

    expect(subagentRuns.has(runId)).toBe(false);
    expect(findTaskByRunId(runId)).toEqual(task);
  });

  it("persists gateway-best-effort ownership without creating a CLI task", () => {
    const runId = "gateway-best-effort-receipt";
    const receipt = registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "gateway owns its task projection",
      cleanup: "keep",
      taskRowOwnership: "gateway_best_effort",
    });

    expect(receipt?.kind).toBe("registered");
    receipt?.assertDispatchCurrent();
    expect(subagentRuns.get(runId)?.taskOwnershipPolicy).toBe("gateway_best_effort");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.taskOwnershipPolicy).toBe(
      "gateway_best_effort",
    );
    expect(findTaskByRunId(runId)).toBeUndefined();
  });

  it("rejects cancellation while keeping custom task storage opaque to dispatch receipts", () => {
    const cancelledRunId = "cancelled-dispatch-receipt";
    const cancelled = registerSubagentRun({
      runId: cancelledRunId,
      childSessionKey: `agent:main:subagent:${cancelledRunId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cancel before dispatch",
      cleanup: "keep",
      queued: true,
      taskRowOwnership: "required",
    });
    cancelled?.assertDispatchCurrent();
    expect(testing.failQueuedSubagentRun(cancelledRunId, "cancelled before dispatch")).toBe(true);
    expect(() => cancelled?.assertDispatchCurrent()).toThrow("ownership changed");

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => {
        if (!params.runId) {
          throw new Error("custom receipt fixture requires a run id");
        }
        return {
          taskId: "custom-same-id-task",
          runtime: params.runtime,
          requesterSessionKey: params.requesterSessionKey ?? "",
          ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
          scopeKind: params.scopeKind ?? "session",
          childSessionKey: params.childSessionKey,
          runId: params.runId,
          task: params.task,
          status: "queued" as const,
          deliveryStatus: params.deliveryStatus ?? "pending",
          notifyPolicy: params.notifyPolicy ?? "silent",
          createdAt: Date.now(),
        };
      },
      findTaskRun: undefined,
    });
    const customRunId = "custom-same-id-receipt";
    const custom = registerSubagentRun({
      runId: customRunId,
      childSessionKey: `agent:main:subagent:${customRunId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replace custom backing",
      cleanup: "keep",
      queued: true,
      taskRowOwnership: "required",
    });
    custom?.assertDispatchCurrent();
    expect(custom?.kind).toBe("owned");
    expect(subagentRuns.get(customRunId)?.taskOwnershipPolicy).toBe("custom");
    expect(loadSubagentRegistryFromSqlite().get(customRunId)?.taskOwnershipPolicy).toBe("custom");
    const customEntry = subagentRuns.get(customRunId)!;
    subagentRuns.set(customRunId, structuredClone(customEntry));
    expect(() => custom?.assertDispatchCurrent()).toThrow("ownership changed");
  });

  it("commits the gateway id without changing public task identity", () => {
    const reservedRunId = "reserved-success";
    const acceptedRunId = "accepted-success";
    const task = registerPreparedCollector(reservedRunId);

    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);

    expect(subagentRuns.has(reservedRunId)).toBe(false);
    expect(subagentRuns.get(acceptedRunId)).toMatchObject({
      runId: acceptedRunId,
      swarmRunId: reservedRunId,
      taskRunId: reservedRunId,
      execution: { status: "running" },
    });
    expect(loadSubagentRegistryFromSqlite().get(acceptedRunId)).toMatchObject({
      swarmRunId: reservedRunId,
      taskRunId: reservedRunId,
    });
    expect(findTaskByRunId(reservedRunId)).toMatchObject({
      taskId: task.taskId,
      runId: reservedRunId,
      status: "running",
    });
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
      runId: reservedRunId,
      status: "running",
    });
  });

  it.each(["subagent_runs", "task_runs", "task_delivery_state"] as const)(
    "rolls back every required registration row when %s insertion fails",
    (table) => {
      const runId = `registration-write-fault-${table}`;
      const database = openOpenClawStateDatabase();
      database.db.exec(`
      CREATE TRIGGER fail_required_${table}
      BEFORE INSERT ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'injected ${table} registration failure');
      END
    `);

      try {
        expect(() =>
          registerSubagentRun({
            runId,
            childSessionKey: `agent:main:subagent:${runId}`,
            requesterSessionKey: "agent:main:main",
            requesterOrigin: { channel: "telegram", to: "test-chat" },
            requesterDisplayKey: "main",
            task: "fail the atomic registration write",
            cleanup: "keep",
            collect: true,
            groupId: "atomic-registration",
            queued: true,
            taskRowOwnership: "required",
          }),
        ).toThrow(`injected ${table} registration failure`);

        expect(subagentRuns.has(runId)).toBe(false);
        expect(readSubagentRun(database, runId)).toBeNull();
        expect(findTaskByRunId(runId)).toBeUndefined();
        const taskSnapshot = loadTaskRegistryStateFromSqlite();
        expect(taskSnapshot.tasks.size).toBe(0);
        expect(taskSnapshot.deliveryStates.size).toBe(0);
      } finally {
        database.db.exec(`DROP TRIGGER IF EXISTS fail_required_${table}`);
      }
    },
  );

  it.each(["deleted", "replaced"] as const)(
    "stops deferred task observers and lifecycle after the run is %s by an observer",
    async (action) => {
      const runId = `registration-observer-${action}`;
      const requests: Array<{ method: string; params: CallGatewayOptions["params"] }> = [];
      let changed = false;
      const taskObserver = vi.fn();
      const unsubscribe = onSubagentRegistryPersisted(() => {
        if (changed) {
          return;
        }
        changed = true;
        const current = subagentRuns.get(runId);
        if (!current) {
          return;
        }
        if (action === "deleted") {
          subagentRuns.delete(runId);
        } else {
          subagentRuns.set(runId, structuredClone(current));
        }
      });
      configureTaskRegistryRuntime({
        observers: {
          onEvent: (event) => {
            if (event.kind === "upserted" && event.task.runId === runId) {
              taskObserver();
            }
          },
        },
      });
      testing.setDepsForTest({
        ...createSubagentRegistryTestDeps(),
        persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
        callGateway: async <T>(request: CallGatewayOptions) => {
          requests.push({
            method: request.method,
            params: request.params ?? {},
          });
          return { status: "pending" } as T;
        },
      });
      try {
        registerSubagentRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "observer retires registration",
          cleanup: "keep",
          taskRowOwnership: "required",
        });
        await Promise.resolve();
      } finally {
        unsubscribe();
      }

      expect(taskObserver).not.toHaveBeenCalled();
      expect(requests.some((request) => request.method === "agent.wait")).toBe(false);
    },
  );

  it("hydrates cold default task state before queued acceptance", () => {
    const reservedRunId = "reserved-cold-default";
    const acceptedRunId = "accepted-cold-default";
    const task = registerPreparedCollector(reservedRunId);

    resetTaskRegistryForTests({ persist: false });

    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    expect(findTaskByRunId(reservedRunId)).toMatchObject({
      taskId: task.taskId,
      status: "running",
    });
  });

  it("publishes both registration caches before either observer runs", () => {
    const runId = "registration-observer";
    const snapshots: Array<{ observer: string; run?: string; task?: string }> = [];
    const observedTasks: Array<Omit<TaskRecord, "detail">> = [];
    const capture = (observer: string) => {
      snapshots.push({
        observer,
        run: getSubagentRunsSnapshotForRead(new Map()).get(runId)?.execution.status,
        task: findTaskByRunId(runId)?.status,
      });
    };
    const unsubscribe = onSubagentRegistryPersisted(() => capture("subagent"));
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (event.kind === "upserted" && event.task.runId === runId) {
            observedTasks.push(event.task);
            capture("task");
          }
        },
      },
    });
    try {
      registerPreparedCollector(runId);
    } finally {
      unsubscribe();
    }

    expect(snapshots).toEqual([
      { observer: "subagent", run: "queued", task: "queued" },
      { observer: "task", run: "queued", task: "queued" },
    ]);
    expect(observedTasks).toHaveLength(1);
    expect(observedTasks[0]).not.toHaveProperty("detail");
    expect(findTaskByRunId(runId)?.detail).toMatchObject({
      kind: "task_backing_instance",
      generation: 1,
    });
  });

  it("reopens one stable required registry and task generation", () => {
    const runId = "registration-reopen";
    const task = registerPreparedCollector(runId);

    closeOpenClawStateDatabaseForTest();

    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      runId,
      taskRunId: runId,
      generation: 1,
      execution: { status: "queued" },
    });
    const reopened = loadTaskRegistryStateFromSqlite();
    expect(reopened.tasks.get(task.taskId)).toMatchObject({
      runId,
      ownerKey: "agent:main:main",
      childSessionKey: `agent:main:subagent:${runId}`,
      status: "queued",
      detail: {
        kind: "task_backing_instance",
        runtime: "subagent",
        generation: 1,
      },
    });
  });

  it("publishes both primed caches before either acceptance observer runs", () => {
    const reservedRunId = "reserved-observer";
    const acceptedRunId = "accepted-observer";
    const task = registerPreparedCollector(reservedRunId);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(reservedRunId)).toBe(true);
    const snapshots: Array<{ observer: string; oldRun: boolean; run?: string; task?: string }> = [];
    const observedTasks: Array<Omit<TaskRecord, "detail">> = [];
    const capture = (observer: string) => {
      const runs = getSubagentRunsSnapshotForRead(new Map());
      snapshots.push({
        observer,
        oldRun: runs.has(reservedRunId),
        run: runs.get(acceptedRunId)?.execution.status,
        task: findTaskByRunId(reservedRunId)?.status,
      });
    };
    const unsubscribe = onSubagentRegistryPersisted(() => capture("subagent"));
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (event.kind === "upserted" && event.task.taskId === task.taskId) {
            observedTasks.push(event.task);
            if (event.previous) {
              observedTasks.push(event.previous);
            }
            capture("task");
          }
        },
      },
    });
    try {
      expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(snapshots).toEqual([
      { observer: "subagent", oldRun: false, run: "running", task: "running" },
      { observer: "task", oldRun: false, run: "running", task: "running" },
    ]);
    expect(observedTasks).toMatchObject([{ status: "running" }, { status: "queued" }]);
    for (const observed of observedTasks) {
      expect(observed).not.toHaveProperty("detail");
    }
    expect(findTaskByRunId(reservedRunId)?.detail).toEqual(task.detail);
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.detail).toEqual(task.detail);
  });

  it("stops acceptance callbacks and waits when an observer replaces the accepted owner", async () => {
    const reservedRunId = "reserved-observer-replaced";
    const acceptedRunId = "accepted-observer-replaced";
    const task = registerPreparedCollector(reservedRunId);
    const taskObserver = vi.fn();
    const requests: CallGatewayOptions[] = [];
    let replaced = false;
    const unsubscribe = onSubagentRegistryPersisted(() => {
      const current = subagentRuns.get(acceptedRunId);
      if (!replaced && current) {
        replaced = true;
        subagentRuns.set(acceptedRunId, structuredClone(current));
      }
    });
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (event.kind === "upserted" && event.task.taskId === task.taskId) {
            taskObserver();
          }
        },
      },
    });
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      callGateway: async <T>(request: CallGatewayOptions) => {
        requests.push(request);
        return { status: "pending" } as T;
      },
    });
    try {
      expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expect(taskObserver).not.toHaveBeenCalled();
    expect(requests.some((request) => request.method === "agent.wait")).toBe(false);
  });

  it("keeps both prepared rows queued on an accepted id collision", () => {
    const reservedRunId = "reserved-collision";
    const acceptedRunId = "accepted-collision";
    registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare(
        `INSERT INTO subagent_runs
          (run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json)
         SELECT ?, child_session_key, controller_session_key, requester_session_key, created_at, payload_json
         FROM subagent_runs WHERE run_id = ?`,
      )
      .run(acceptedRunId, reservedRunId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow();

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).not.toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("keeps both prepared rows queued when the task snapshot drifts", () => {
    const reservedRunId = "reserved-drift";
    const acceptedRunId = "accepted-drift";
    const task = registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE task_runs SET status = 'running' WHERE task_id = ?")
      .run(task.taskId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "prepared task state changed before atomic acceptance",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("keeps both prepared rows queued when the subagent snapshot drifts", () => {
    const reservedRunId = "reserved-run-drift";
    const acceptedRunId = "accepted-run-drift";
    registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE subagent_runs SET requester_session_key = ? WHERE run_id = ?")
      .run("agent:main:drifted", reservedRunId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "collector run state changed before gateway acceptance",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("rolls back both prepared rows when the transaction fails", () => {
    const reservedRunId = "reserved-rollback";
    const acceptedRunId = "accepted-rollback";
    const task = registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db.exec(`
      CREATE TEMP TRIGGER fail_collector_acceptance
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'injected acceptance failure');
      END
    `);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "injected acceptance failure",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
      status: "queued",
    });
  });

  it("accepts a non-mirrored custom task runtime with the stable task id", () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const startTaskRunByRunId = vi.fn(() => []);
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => ({
        taskId: "custom-task",
        runtime: params.runtime,
        requesterSessionKey: params.requesterSessionKey ?? "",
        ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
        scopeKind: params.scopeKind ?? "session",
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        task: params.task,
        status: "queued",
        deliveryStatus: params.deliveryStatus ?? "pending",
        notifyPolicy: params.notifyPolicy ?? "silent",
        createdAt: Date.now(),
      }),
      startTaskRunByRunId,
    });
    const reservedRunId = "custom-reserved";
    const acceptedRunId = "custom-accepted";

    registerPreparedCollector(reservedRunId);

    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    expect(startTaskRunByRunId).toHaveBeenCalledWith({
      runId: reservedRunId,
      runtime: "subagent",
      sessionKey: `agent:main:subagent:${reservedRunId}`,
      startedAt: expect.any(Number),
      lastEventAt: expect.any(Number),
    });
    expect(subagentRuns.get(acceptedRunId)).toMatchObject({
      runId: acceptedRunId,
      taskRunId: reservedRunId,
      swarmRunId: reservedRunId,
      execution: { status: "running" },
    });
    expect(loadSubagentRegistryFromSqlite().get(acceptedRunId)).toMatchObject({
      taskRunId: reservedRunId,
      swarmRunId: reservedRunId,
    });
    expect(findTaskByRunId(reservedRunId)).toBeUndefined();
  });

  it("restores a custom runtime row before aborting the exact accepted id", async () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    let customTask: ReturnType<typeof defaultRuntime.createQueuedTaskRun>;
    const startTaskRunByRunId = vi.fn(() => {
      throw new Error("custom runtime start failed");
    });
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) =>
        (customTask = {
          taskId: "custom-failure-task",
          runtime: params.runtime,
          requesterSessionKey: params.requesterSessionKey ?? "",
          ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
          scopeKind: params.scopeKind ?? "session",
          childSessionKey: params.childSessionKey,
          runId: params.runId,
          task: params.task,
          status: "queued",
          deliveryStatus: params.deliveryStatus ?? "pending",
          notifyPolicy: params.notifyPolicy ?? "silent",
          createdAt: Date.now(),
        }),
      findTaskRun: () => customTask ?? undefined,
      startTaskRunByRunId,
    });
    const abortEntered = createDeferred();
    const releaseAbort = createDeferred();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          return { runId: "gateway-accepted-custom", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          abortEntered.resolve();
          await releaseAbort.promise;
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "rollback custom runtime collector",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "custom-rollback",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    await abortEntered.promise;
    const reservedRunId = result.runId!;
    const database = openOpenClawStateDatabase();
    expect(startTaskRunByRunId).toHaveBeenCalledWith({
      runId: reservedRunId,
      runtime: "subagent",
      sessionKey: expect.any(String),
      startedAt: expect.any(Number),
      lastEventAt: expect.any(Number),
    });
    expect(requests).toContainEqual({
      method: "chat.abort",
      params: expect.objectContaining({ runId: "gateway-accepted-custom" }),
    });
    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, "gateway-accepted-custom")).toBeNull();
    expect(findTaskByRunId(reservedRunId)).toBeUndefined();

    releaseAbort.resolve();
    await vi.waitFor(() => {
      expect(subagentRuns.get(reservedRunId)?.collectorCompletion).toMatchObject({
        status: "failed",
      });
    });
  });

  it("aborts the exact accepted id after atomic acceptance rolls back", async () => {
    const abortEntered = createDeferred();
    const releaseAbort = createDeferred();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          return { runId: "gateway-accepted-atomic", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          abortEntered.resolve();
          await releaseAbort.promise;
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });
    openOpenClawStateDatabase().db.exec(`
      CREATE TEMP TRIGGER fail_spawn_collector_acceptance
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'injected atomic acceptance failure');
      END
    `);

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "rollback accepted collector",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "atomic-rollback",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    await abortEntered.promise;
    const reservedRunId = result.runId!;
    const task = findTaskByRunId(reservedRunId)!;
    const database = openOpenClawStateDatabase();
    expect(requests).toContainEqual({
      method: "chat.abort",
      params: expect.objectContaining({ runId: "gateway-accepted-atomic" }),
    });
    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, "gateway-accepted-atomic")).toBeNull();
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe("queued");

    releaseAbort.resolve();
    await vi.waitFor(() => {
      expect(subagentRuns.get(reservedRunId)?.collectorCompletion).toMatchObject({
        status: "failed",
      });
    });
  });

  it.each([
    {
      name: "missing",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        deleteTaskRecordById(task.taskId);
      },
    },
    {
      name: "owner mismatch",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE task_runs SET owner_key = ? WHERE task_id = ?")
          .run("agent:main:other", task.taskId);
        publishTaskRecordAfterAtomicStore({ ...task, ownerKey: "agent:main:other" });
      },
    },
    {
      name: "terminal",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE task_runs SET status = 'failed', ended_at = ? WHERE task_id = ?")
          .run(Date.now(), task.taskId);
        publishTaskRecordAfterAtomicStore({
          ...task,
          status: "failed",
          endedAt: Date.now(),
        });
      },
    },
    {
      name: "generation mismatch",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        const detail = {
          kind: "task_backing_instance",
          runtime: "subagent",
          generation: 2,
        } as const;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE task_runs SET detail_json = ? WHERE task_id = ?")
          .run(JSON.stringify(detail), task.taskId);
        publishTaskRecordAfterAtomicStore({ ...task, detail });
      },
    },
    {
      name: "missing backing detail",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE task_runs SET detail_json = NULL WHERE task_id = ?")
          .run(task.taskId);
        publishTaskRecordAfterAtomicStore({ ...task, detail: undefined });
      },
    },
    {
      name: "malformed backing detail",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        const detail = {
          kind: "task_backing_instance",
          runtime: "subagent",
          generation: 0,
        } as const;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE task_runs SET detail_json = ? WHERE task_id = ?")
          .run(JSON.stringify(detail), task.taskId);
        publishTaskRecordAfterAtomicStore({ ...task, detail });
      },
    },
    {
      name: "missing registered generation",
      mutate: (task: NonNullable<ReturnType<typeof findTaskByRunId>>) => {
        const entry = subagentRuns.get(task.runId!);
        if (entry) {
          entry.generation = undefined;
          saveSubagentRegistryToSqlite(subagentRuns);
        }
      },
    },
  ])("does not dispatch when the required task backing is $name", async ({ mutate }) => {
    let mutated = false;
    let expectedTaskAfterFailure: ReturnType<typeof findTaskByRunId>;
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (
            !mutated &&
            event.kind === "upserted" &&
            event.task.status === "queued" &&
            event.task.runtime === "subagent"
          ) {
            mutated = true;
            mutate(event.task);
            expectedTaskAfterFailure = findTaskByRunId(event.task.runId!);
          }
        },
      },
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        return {} as T;
      },
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "reject invalid required backing",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "backing-validation",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    const runId = result.runId!;
    await vi.waitFor(() => {
      expect(subagentRuns.get(runId)?.collectorCompletion).toMatchObject({
        status: "failed",
      });
      expect(subagentRuns.get(runId)?.completion?.resultText ?? "").toContain(
        "Retry the spawn request",
      );
    });
    expect(requests.some((request) => request.method === "agent")).toBe(false);
    expect(findTaskByRunId(runId)).toEqual(expectedTaskAfterFailure);
  });

  it("does not overwrite mismatched task ownership after a cold reopen cleanup", () => {
    const runId = "cold-reopen-mismatch";
    const task = registerPreparedCollector(runId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE task_runs SET owner_key = ? WHERE task_id = ?")
      .run("agent:main:newer-owner", task.taskId);
    closeOpenClawStateDatabaseForTest();
    resetTaskRegistryForTests({ persist: false });

    expect(testing.failQueuedSubagentRun(runId, "collector dispatch rejected")).toBe(true);

    const reopened = loadTaskRegistryStateFromSqlite().tasks.get(task.taskId);
    expect(reopened).toMatchObject({
      ownerKey: "agent:main:newer-owner",
      status: "queued",
    });
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: { status: "error", error: "collector dispatch rejected" },
      },
      completion: { resultText: "collector dispatch rejected" },
    });
  });

  it("rejects terminal projection when durable ownership changed behind a stale cache", () => {
    const runId = "stale-cache-owner-mismatch";
    const task = registerPreparedCollector(runId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE task_runs SET owner_key = ? WHERE task_id = ?")
      .run("agent:main:newer-owner", task.taskId);

    expect(testing.failQueuedSubagentRun(runId, "collector dispatch rejected")).toBe(true);

    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
      ownerKey: "agent:main:newer-owner",
      status: "queued",
    });
  });
});
