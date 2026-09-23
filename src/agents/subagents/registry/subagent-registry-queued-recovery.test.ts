import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  getDetachedTaskLifecycleRuntime,
  startTaskRunByRunId,
} from "../../../tasks/detached-task-runtime.js";
import { reloadTaskRuntimeStateFromStore } from "../../../tasks/runtime-internal.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import {
  findTaskByRunId,
  getTaskById,
  listTasksForOwnerKey,
} from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/task-runtime.test-helpers.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../../../test-utils/task-registry-store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-state.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = vi.hoisted(() => ({
  sessionId: "retained-collector-session",
  lifecycleRevision: "retained-collector-lifecycle",
}));
let taskStore: ReturnType<typeof createInMemoryTaskRegistryStore>;
let flowStore: ReturnType<typeof createInMemoryTaskFlowRegistryStore>;
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: vi.fn(async () => null),
  findTranscriptEvent: () => {
    throw new Error("Unexpected transcript lookup in queued registration recovery");
  },
}));
vi.mock("../../../gateway/call.js", () => ({ callGateway: vi.fn() }));
vi.mock("./subagent-registry-state.js", { spy: true });
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => ({
    sessionId: fixture.sessionId,
    lifecycleRevision: fixture.lifecycleRevision,
  }),
}));

beforeEach(() => {
  vi.mocked(patchSessionEntryCore).mockClear();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetDetachedTaskLifecycleRuntimeForTests();
  taskStore = createInMemoryTaskRegistryStore();
  flowStore = createInMemoryTaskFlowRegistryStore();
  configureTaskRegistryRuntime({ store: taskStore });
  configureTaskFlowRegistryRuntime({ store: flowStore });
  subagentRuns.clear();
});
afterEach(() => {
  vi.mocked(restoreSubagentRunsFromDisk).mockReset();
  subagentRuns.clear();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetDetachedTaskLifecycleRuntimeForTests();
});

function createRegistrationFixture() {
  const stored = new Map<string, SubagentRunRecord>();
  const persist = (...runIds: string[]) => {
    for (const runId of runIds.length > 0 ? runIds : subagentRuns.keys()) {
      const entry = subagentRuns.get(runId);
      if (entry) {
        stored.set(runId, structuredClone(entry));
      } else {
        stored.delete(runId);
      }
    }
  };
  const options: SubagentManagerOptions = {
    runs: subagentRuns,
    getRunsForChildSession: (key) =>
      [...subagentRuns.values()].filter((run) => run.childSessionKey === key),
    resumedRuns: new Set(),
    persist,
    persistOrThrow: persist,
    persistAsyncOrThrow: async (_context, publication, ...runIds) => {
      publication.assertCurrent();
      if (stored.size > 0) {
        throw new SubagentRegistryWriteError("not-committed", new Error("descriptor refused"));
      }
      persist(...runIds);
      await Promise.resolve();
      publication.onCommitted?.();
    },
    callGateway: async () => {
      throw new Error("Unexpected registration Gateway call");
    },
    getRuntimeConfig: () => ({}),
    ensureListener: () => {},
    startSweeper: () => {},
    stopSweeper: () => {},
    resumeSubagentRun: () => {},
    clearPendingLifecycleError: () => {},
    clearPendingLifecycleTimeout: () => {},
    resolveSubagentWaitTimeoutMs: () => 100,
    scheduleSweep: () => {},
    resolveSubagentSessionCompletion: () => null,
    resolveSubagentSessionStartedAt: () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: () => {},
    completeSubagentRun: async () => {},
    resolveSubagentTask: () => ({ lookup: "unavailable" }),
  };
  const manager = createSubagentRunManager(options);
  return { stored, persist, options, manager };
}

it("supersedes retired cancellation ownership after a known refused no-task rollback", async () => {
  const { stored, persist, options, manager } = createRegistrationFixture();
  const childSessionKey = "agent:main:subagent:retained-ownership";
  const successorId = "durably-retained-successor";
  const ancestor: SubagentRunRecord = {
    runId: "retired-ancestor",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    controllerSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "retired ancestor",
    cleanup: "keep",
    generation: 1,
    createdAt: 1,
    execution: {
      status: "terminal",
      endedAt: 2,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
    killReconciliation: { killedAt: 2 },
  };
  subagentRuns.set(ancestor.runId, ancestor);
  subagentRuns.commitOwnership(ancestor);
  persist(ancestor.runId);
  const retirement = subagentRuns.captureRetirement(
    ancestor,
    (candidate) => getLatestLiveSubagentRunByChildSessionKey(childSessionKey) === candidate,
  );
  subagentRuns.delete(ancestor.runId);
  persist(ancestor.runId);
  subagentRuns.confirmRetirement(ancestor);
  expect(retirement.observation).toMatchObject({ entry: ancestor, state: "retired" });
  const rollbackRefusal = new SubagentRegistryWriteError(
    "not-committed",
    new Error("deletion refused before commit"),
  );
  let registryWrites = 0;
  options.persistAsyncOrThrow = async (_context, publication, ...runIds) => {
    publication.assertCurrent();
    registryWrites += 1;
    if (!subagentRuns.has(successorId)) {
      expect(stored.has(successorId)).toBe(true);
      throw rollbackRefusal;
    }
    persist(...runIds);
    await Promise.resolve();
    publication.onCommitted?.();
  };
  const createTask = vi.fn(() => {
    expect(stored.get(successorId)).toMatchObject({ execution: { status: "queued" } });
    expect(stored.get(successorId)?.queuedLaunch).toBeUndefined();
    return null;
  });
  setDetachedTaskLifecycleRuntime({
    ...getDetachedTaskLifecycleRuntime(),
    createQueuedTaskRun: createTask,
  });
  const taskWrite = vi.spyOn(taskStore, "upsertTaskWithDeliveryState");
  const transport = vi.spyOn(options, "callGateway");
  const sql = observeMainThreadSql();
  let scope: SubagentRegistrationScope | undefined;
  try {
    await expect(
      manager.registerSubagentRun(
        {
          runId: successorId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterDisplayKey: "main",
          task: "successor with failed rollback",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
          expectsCompletionMessage: false,
        },
        {
          retainOwnership: (value) => {
            scope = value;
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "Queued registration rollback failed",
      errors: [
        expect.objectContaining({
          message: `detached task runtime created no task row for run ${successorId}`,
        }),
        rollbackRefusal,
      ],
    });
    const successor = expectDefined(subagentRuns.get(successorId), "restored durable intent");
    expect(stored.get(successorId)).toEqual(successor);
    expect(successor.execution.status).toBe("queued");
    expect(successor.queuedLaunch).toBeUndefined();
    expect(expectDefined(scope, "retained scope").canLaunch()).toBe(false);
    expect(createTask).toHaveBeenCalledOnce();
    expect(taskWrite).not.toHaveBeenCalled();
    expect(taskStore.loadSnapshot().tasks.size).toBe(0);
    expect(findTaskByRunId(successorId)).toBeUndefined();
    expect(registryWrites).toBe(2);
    const observationBeforeRelease = retirement.observation.state;
    manager.releaseSubagentRun(successorId);
    expect(stored.has(successorId)).toBe(false);
    expect(subagentRuns.has(successorId)).toBe(false);
    expect(observationBeforeRelease).toBe("superseded");
    expect(retirement.observation.state).toBe("superseded");
    expect(createTask).toHaveBeenCalledOnce();
    expect(taskWrite).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    sql.expectIdle();
  } finally {
    retirement.release();
    taskWrite.mockRestore();
    transport.mockRestore();
    try {
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  }
});

it.each(["restart", "restart with newer sibling", "confirmed Stop"] as const)(
  "reconciles a retained descriptorless registration through %s",
  async (recovery) => {
    const newerSibling = recovery === "restart with newer sibling";
    const { stored, persist, manager } = createRegistrationFixture();
    let ownership: SubagentRegistrationScope | undefined;
    const runId = "retained-registration";
    const childSessionKey = "agent:main:subagent:retained-registration";
    const sql = observeMainThreadSql();
    const transport = vi.mocked(callGateway).mockReset().mockResolvedValue({});
    const cleanupResources = vi.fn(async () => true);
    const cleaned = vi.fn();
    const resume = vi.fn();
    const startQueued = vi.fn(() => true);
    vi.mocked(restoreSubagentRunsFromDisk).mockImplementation(({ runs }) => {
      for (const [id, entry] of stored) {
        runs.set(id, structuredClone(entry));
      }
      return stored.size;
    });
    const restorer = createSubagentRegistryRestorer({
      runs: subagentRuns,
      getGatewayContextResolver: () => undefined,
      bindGatewayOwners: () => true,
      persist,
      persistOrThrow: persist,
      settleRequesterTurn: () => false,
      ensureListener: () => {},
      startSweeper: () => {},
      scheduleSweep: () => {},
      resumeRun: resume,
      listSwarmRunsForGroup: () => [...subagentRuns.values()],
      startQueuedSubagentRun: startQueued,
      terminateAcceptedRestoredCollectorRun: async () => {},
      cleanupCollectorLaunchResources: cleanupResources,
      settleFailedQueuedSubagentLaunch: manager.settleFailedQueuedSubagentLaunch,
      completeCollectorLaunchCleanup: cleaned,
      warn: () => {},
    });
    try {
      await expect(
        manager.registerSubagentRun(
          {
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            requesterAgentId: "main",
            task: "retained registration recovery",
            cleanup: "keep",
            collect: true,
            groupId: "retained-group",
            queued: true,
            taskRowOwnership: "required",
            queuedLaunch: {
              request: { sessionKey: childSessionKey },
              timeoutMs: 100,
              schedulerGroupKey: "retained-group",
              maxConcurrent: 1,
            },
          },
          {
            retainOwnership: (scope) => {
              ownership = scope;
            },
          },
        ),
      ).rejects.toMatchObject({ outcome: "not-committed" });
      const task = expectDefined(findTaskByRunId(runId), "created queued task");
      expect(task.status).toBe("queued");
      expect(stored.get(runId)?.queuedLaunch).toBeUndefined();
      expect(stored.get(runId)?.execution.status).toBe("queued");
      expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(cleanupResources).not.toHaveBeenCalled();

      if (recovery === "confirmed Stop") {
        expect(manager.markSubagentRunTerminated({ runId })).toBe(1);
        const stopped = expectDefined(subagentRuns.get(runId), "stopped original run");
        const stoppedExecution = stopped.execution;
        expect(getTaskById(task.taskId)?.status).toBe("cancelled");
        expect(stored.get(runId)?.killReconciliation).toBeDefined();
        await expect(
          expectDefined(ownership, "registration scope").settleFailedLaunch("later callback"),
        ).resolves.toBeUndefined();
        expect(stopped.execution).toBe(stoppedExecution);
        expect(getTaskById(task.taskId)?.status).toBe("cancelled");
        expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
        expect(patchSessionEntryCore).toHaveBeenCalled();
        return;
      }

      let successorTaskId: string | undefined;
      if (newerSibling) {
        const original = expectDefined(stored.get(runId), "retained original intent");
        const successor: SubagentRunRecord = {
          ...structuredClone(original),
          runId: "recovered-successor",
          generation: (original.generation ?? 0) + 1,
          execution: {
            status: "running",
            startedAt: Date.now(),
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        };
        stored.set(successor.runId, successor);
        subagentRuns.set(successor.runId, successor);
        successorTaskId = expectDefined(
          createRunningTaskRun({
            runtime: "subagent",
            sourceId: successor.runId,
            runId: successor.runId,
            ownerKey: original.requesterSessionKey,
            scopeKind: "session",
            childSessionKey,
            task: "newer restored owner",
            startedAt: Date.now(),
            detail: createSubagentTaskBackingDetail(successor.generation ?? 0),
          }),
          "newer task",
        ).taskId;
      }
      subagentRuns.clear();
      const taskReload = vi.spyOn(taskStore, "withSnapshotAsync");
      const flowReload = vi.spyOn(flowStore, "withSnapshotAsync");
      try {
        await reloadTaskRuntimeStateFromStore();
        expect(taskReload).toHaveBeenCalledOnce();
        expect(flowReload).toHaveBeenCalledOnce();
        expect(getTaskById(task.taskId)?.status).toBe("queued");
      } finally {
        taskReload.mockRestore();
        flowReload.mockRestore();
      }
      restorer.restoreOnce();
      restorer.activate();
      await vi.waitFor(() => expect(getTaskById(task.taskId)?.status).toBe("failed"));
      expect(
        listTasksForOwnerKey("agent:main:main")
          .map((record) => record.taskId)
          .toSorted(),
      ).toEqual([task.taskId, ...(successorTaskId ? [successorTaskId] : [])].toSorted());
      expect(stored.get(runId)).toMatchObject({
        execution: { status: "terminal", lifecycleGeneration: getAgentEventLifecycleGeneration() },
        collectorCompletion: { status: "failed" },
      });
      if (newerSibling) {
        expect(transport).not.toHaveBeenCalled();
        expect(cleanupResources).not.toHaveBeenCalled();
        expect(stored.get(runId)?.execution.suppressSessionEffects).toBe(true);
        expect(getTaskById(expectDefined(successorTaskId, "newer task id"))?.status).toBe(
          "running",
        );
        expect(resume).toHaveBeenCalledExactlyOnceWith("recovered-successor");
      } else {
        expect(transport).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            method: "sessions.delete",
            params: expect.objectContaining({
              key: childSessionKey,
              expectedSessionId: fixture.sessionId,
              expectedLifecycleRevision: fixture.lifecycleRevision,
            }),
          }),
        );
        expect(cleanupResources).toHaveBeenCalledOnce();
        expect(cleaned).toHaveBeenCalledExactlyOnceWith(runId);
        expect(resume).not.toHaveBeenCalled();
      }
      expect(startQueued).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      try {
        restorer.reset();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }
  },
);

it.each([false, true])(
  "fails only the originally created task after descriptor commit (normalized timestamp=%s)",
  async (normalizedTimestamp) => {
    const { stored, persist, options, manager } = createRegistrationFixture();
    const originalRunId = "post-ack-original";
    const successorRunId = "post-ack-successor";
    const childSessionKey = "agent:main:subagent:post-ack-owner";
    let originalTaskId: string | undefined;
    let successorTaskId: string | undefined;
    let writes = 0;
    const taskStartedAt = Date.now() + 60_000;
    const persistedTransitions: Array<{
      registry: SubagentRunRecord["execution"]["status"] | undefined;
      launchable: boolean;
      task: string | undefined;
    }> = [];
    options.persistAsyncOrThrow = async (_context, callbacks, ...runIds) => {
      callbacks.assertCurrent();
      persist(...runIds);
      writes += 1;
      persistedTransitions.push({
        registry: stored.get(originalRunId)?.execution.status,
        launchable: Boolean(stored.get(originalRunId)?.queuedLaunch),
        task: findTaskByRunId(originalRunId)?.status,
      });
      if (writes === 2) {
        originalTaskId = expectDefined(
          findTaskByRunId(originalRunId),
          "created original task",
        ).taskId;
        if (normalizedTimestamp) {
          // A backend's lifecycle clock can be ahead of the registration failure clock.
          const started = startTaskRunByRunId({
            runId: originalRunId,
            taskId: originalTaskId,
            runtime: "subagent",
            sessionKey: childSessionKey,
            startedAt: taskStartedAt,
            lastEventAt: taskStartedAt,
          });
          expect(started).toHaveLength(1);
        }
        const original = expectDefined(subagentRuns.get(originalRunId), "original registration");
        const successor: SubagentRunRecord = {
          ...structuredClone(original),
          runId: successorRunId,
          generation: (original.generation ?? 0) + 1,
          queuedLaunch: undefined,
        };
        subagentRuns.set(successorRunId, successor);
        successorTaskId = expectDefined(
          createQueuedTaskRun({
            runtime: "subagent",
            sourceId: successorRunId,
            runId: successorRunId,
            ownerKey: original.requesterSessionKey,
            scopeKind: "session",
            childSessionKey,
            task: "successor task",
            detail: createSubagentTaskBackingDetail(successor.generation ?? 0),
          }),
          "successor task",
        ).taskId;
      }
      await Promise.resolve();
      callbacks.onCommitted?.();
    };
    const sql = observeMainThreadSql();
    try {
      await expect(
        manager.registerSubagentRun({
          runId: originalRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterAgentId: "main",
          task: "original task",
          cleanup: "keep",
          collect: true,
          groupId: "post-ack-group",
          queued: true,
          taskRowOwnership: "required",
          queuedLaunch: {
            request: { sessionKey: childSessionKey },
            timeoutMs: 100,
            schedulerGroupKey: "post-ack-group",
            maxConcurrent: 1,
          },
        }),
      ).rejects.toThrow("original run owner");
      const originalTask = expectDefined(
        getTaskById(expectDefined(originalTaskId, "original task id")),
        "original created task",
      );
      const successorId = expectDefined(successorTaskId, "successor task id");
      expect(originalTask.status).toBe("failed");
      if (normalizedTimestamp) {
        expect(originalTask.endedAt).toBe(taskStartedAt);
      }
      expect(stored.get(originalRunId)?.execution.endedAt).toBe(originalTask.endedAt);
      expect(stored.get(originalRunId)?.execution.outcome).toMatchObject({
        status: "error",
        error: originalTask.error,
      });
      expect(getTaskById(successorId)?.status).toBe("queued");
      expect(
        listTasksForOwnerKey("agent:main:main")
          .map((task) => task.taskId)
          .toSorted(),
      ).toEqual([originalTask.taskId, successorId].toSorted());
      expect(stored.get(originalRunId)).toMatchObject({
        execution: { status: "terminal", suppressSessionEffects: true },
        collectorCompletion: { status: "failed" },
      });
      expect(stored.get(originalRunId)?.queuedLaunch).toBeUndefined();
      expect(persistedTransitions).toEqual([
        { registry: "queued", launchable: false, task: undefined },
        { registry: "queued", launchable: true, task: "queued" },
        { registry: "queued", launchable: false, task: normalizedTimestamp ? "running" : "queued" },
        { registry: "terminal", launchable: false, task: "failed" },
      ]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  },
);

it.each(["same-ID successor", "different-ID successor", "Stop"] as const)(
  "rechecks registration authority after the task owner's cold restore observer (%s)",
  async (transition) => {
    const { manager } = createRegistrationFixture();
    const prior: TaskRecord = {
      taskId: "prior-task",
      runtime: "subagent",
      runId: "prior-run",
      ownerKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      scopeKind: "session",
      task: "prior completed work",
      status: "failed",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
      endedAt: 2,
    };
    let successor: SubagentRunRecord | undefined;
    const observer = vi.fn((event: { kind: string }) => {
      if (event.kind !== "restored") {
        return;
      }
      const original = expectDefined(subagentRuns.get("cold-registration"), "original intent");
      if (transition === "Stop") {
        original.execution = { ...original.execution, status: "terminal", endedAt: Date.now() };
        successor = original;
      } else {
        successor = {
          ...structuredClone(original),
          runId: transition === "same-ID successor" ? original.runId : "cold-successor",
          generation: (original.generation ?? 0) + 1,
        };
        subagentRuns.set(successor.runId, successor);
      }
    });
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore({
        tasks: new Map([[prior.taskId, prior]]),
        deliveryStates: new Map(),
      }),
      observers: { onEvent: observer },
    });
    const sql = observeMainThreadSql();
    try {
      await expect(
        manager.registerSubagentRun({
          runId: "cold-registration",
          childSessionKey: "agent:main:subagent:cold-registration",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterAgentId: "main",
          task: "work retired by task restoration",
          cleanup: "keep",
          collect: true,
          groupId: "cold-group",
          queued: true,
          taskRowOwnership: "required",
          queuedLaunch: {
            request: { sessionKey: "agent:main:subagent:cold-registration" },
            timeoutMs: 100,
            schedulerGroupKey: "cold-group",
            maxConcurrent: 1,
          },
        }),
      ).rejects.toThrow();
      expect(observer).toHaveBeenCalledWith({ kind: "restored" });
      expect(findTaskByRunId("cold-registration")).toBeUndefined();
      expect(listTasksForOwnerKey("agent:main:main").map((task) => task.taskId)).toEqual([
        prior.taskId,
      ]);
      expect(subagentRuns.get(expectDefined(successor, "replacement owner").runId)).toBe(successor);
      expect(successor?.queuedLaunch).toBeUndefined();
      sql.expectIdle();
    } finally {
      configureTaskRegistryRuntime({ observers: null });
      sql.restore();
    }
  },
);

it("settles an acknowledged queued launch failure through its original core task backend", async () => {
  const { stored, persist, options, manager } = createRegistrationFixture();
  options.persistAsyncOrThrow = async (_context, publication, ...runIds) => {
    publication.assertCurrent();
    persist(...runIds);
    await Promise.resolve();
    publication.onCommitted?.();
  };
  const runId = "acknowledged-launch-failure";
  const childSessionKey = "agent:main:subagent:acknowledged-launch-failure";
  let scope: SubagentRegistrationScope | undefined;
  await manager.registerSubagentRun(
    {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "registered work awaiting its FIFO slot",
      cleanup: "keep",
      collect: true,
      groupId: "acknowledged-launch-group",
      queued: true,
      taskRowOwnership: "required",
      queuedLaunch: {
        request: { sessionKey: childSessionKey },
        timeoutMs: 100,
        schedulerGroupKey: "acknowledged-launch-group",
        maxConcurrent: 1,
      },
    },
    {
      retainOwnership: (value) => {
        scope = value;
      },
    },
  );
  const original = expectDefined(findTaskByRunId(runId), "acknowledged original task");
  expect(original.status).toBe("queued");
  expect(stored.get(runId)?.queuedLaunch).toBeDefined();
  const replacementFinalize = vi.fn(() => []);
  setDetachedTaskLifecycleRuntime({
    ...getDetachedTaskLifecycleRuntime(),
    finalizeTaskRunByRunId: replacementFinalize,
  });
  await expectDefined(scope, "retained registration").settleFailedLaunch("launch refused");
  expect(replacementFinalize).not.toHaveBeenCalled();
  const terminal = expectDefined(getTaskById(original.taskId), "original task after settlement");
  expect(terminal).toMatchObject({
    taskId: original.taskId,
    status: "failed",
    error: "launch refused",
    deliveryStatus: "not_applicable",
  });
  expect(stored.get(runId)).toMatchObject({
    execution: { status: "terminal", endedAt: terminal.endedAt },
    collectorCompletion: { status: "failed" },
  });
  expect(stored.get(runId)?.queuedLaunch).toBeUndefined();
});
