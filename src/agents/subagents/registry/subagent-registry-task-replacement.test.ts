import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import {
  WorkerLiveEventParamsSchema,
  type WorkerLiveEventParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { registerPluginSubagentRunFromGateway } from "../../../gateway/server-methods/agent-task-tracking.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import type { WorkerConnectionIdentity } from "../../../gateway/worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "../../../gateway/worker-environments/live-events.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "../../../gateway/worker-environments/placement-worker-gate.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
} from "../../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunContextOwnerStatus,
} from "../../../infra/agent-run-registry.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import { reloadTaskRuntimeStateFromStore } from "../../../tasks/runtime-internal.js";
import { failFlow, getTaskFlowById } from "../../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import { getTaskActivitySnapshot } from "../../../tasks/task-registry-activity.js";
import { findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  onSubagentRegistryPersisted,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import {
  markSubagentRunTerminated,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  finalizeInterruptedSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

function coldReloadTaskOwnership(): void {
  closeOpenClawStateDatabaseForTest();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  restoreSubagentRunsFromDisk({ runs: subagentRuns });
  reloadTaskRuntimeStateFromStore();
}

it.each(["end", "error"] as const)(
  "keeps a timeout successor running when its exact predecessor owner publishes its first %s terminal",
  async (phase) => {
    vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
    const oldWait = createDeferred<AgentWaitResult>();
    const nextWait = createDeferred<AgentWaitResult>();
    const previousSettled = createDeferred();
    const successorSettled = createDeferred();
    fixture.persist.mockImplementation((...params) => {
      persistSubagentRunsToDiskOrThrow(...params);
      if (typeof subagentRuns.get("timeout-predecessor")?.cleanupCompletedAt === "number") {
        previousSettled.resolve();
      }
      if (typeof subagentRuns.get("timeout-successor")?.cleanupCompletedAt === "number") {
        successorSettled.resolve();
      }
    });
    vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      return (request.params as { runId: string }).runId === "timeout-predecessor"
        ? await oldWait.promise
        : await nextWait.promise;
    });
    const childSessionKey = "agent:main:subagent:late-owner-terminal";
    const sessionId = "late-owner-terminal-session";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: sessionId,
    });
    registerSubagentRun({
      runId: "timeout-predecessor",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Continue bounded work",
      cleanup: "keep",
      spawnMode: "session",
      expectsCompletionMessage: true,
      runTimeoutSeconds: 1,
      taskRowOwnership: "required",
    });
    const previous = subagentRuns.get("timeout-predecessor")!;
    const originalTask = findTaskByRunId(previous.runId)!;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const placementStore = createWorkerSessionPlacementStore();
    const placementIdentity = { sessionId, sessionKey: childSessionKey, agentId: "main" };
    seedAttachedPlacementEnvironment(openOpenClawStateDatabase(), {
      environmentId: "timeout-worker",
      sessionId,
      ownerEpoch: 1,
    });
    let placement = placementStore.startDispatch(placementIdentity);
    for (const transition of [
      { from: "requested", to: "provisioning", patch: { environmentId: "timeout-worker" } },
      { from: "provisioning", to: "syncing", patch: { workerBundleHash: "b".repeat(64) } },
      {
        from: "syncing",
        to: "starting",
        patch: {
          workspaceBaseManifestRef: "fixture-manifest",
          remoteWorkspaceDir: "/workspace/fixture",
        },
      },
      { from: "starting", to: "active", patch: { activeOwnerEpoch: 1 } },
    ] as const) {
      placement = placementStore.transition({
        sessionId,
        expectedGeneration: placement.generation,
        ...transition,
      });
    }
    const turnClaim = placementStore.claimTurn({
      ...placementIdentity,
      claimId: "fixture-turn-claim",
      runId: previous.runId,
      owner: { kind: "worker", environmentId: "timeout-worker", ownerEpoch: 1 },
    });
    const placementGate = createWorkerSessionPlacementGate(placementStore);
    expect(placementGate.validateWorkerTurn(turnClaim)).toBe(true);
    const identity: WorkerConnectionIdentity = {
      environmentId: "timeout-worker",
      credentialHash: "fixture-worker-hash",
      bundleHash: "b".repeat(64),
      sessionId,
      runId: previous.runId,
      turnClaim,
      ownerEpoch: 1,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-live-event-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    const receiver = createWorkerLiveEventReceiver({
      getConfig: getRuntimeConfig,
      startupBindings: [
        { sessionId, environmentId: identity.environmentId, runEpoch: identity.ownerEpoch },
      ],
      startupOwners: new Map([[identity.environmentId, identity.ownerEpoch]]),
    });
    receiver.start();
    const terminalEvents: string[] = [];
    const stop = onAgentEvent((event) => {
      if (
        event.runId === previous.runId &&
        event.stream === "lifecycle" &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        terminalEvents.push(event.runId);
      }
    });
    try {
      const startedAt = Date.now();
      const startRequest = {
        runId: previous.runId,
        runEpoch: identity.ownerEpoch,
        seq: 1,
        lastAckedSeq: 0,
        event: { kind: "lifecycle", payload: { phase: "start", startedAt } },
      } as const;
      expect(Value.Check(WorkerLiveEventParamsSchema, startRequest)).toBe(true);
      expect(receiver.apply({ identity, request: startRequest })).toEqual({
        ok: true,
        result: { ackedSeq: 1 },
      });
      const claimId = getAgentRunContextOwnership(previous.runId)!.exclusiveClaimId!;
      const owner = getAgentRunContext(previous.runId)!;
      expect(claimId).toBeDefined();
      expect(
        receiver.apply({
          identity,
          request: {
            runId: previous.runId,
            runEpoch: identity.ownerEpoch,
            seq: 2,
            lastAckedSeq: 1,
            event: {
              kind: "assistant",
              payload: { text: "Current owner progress", delta: "Current owner progress" },
            },
          },
        }),
      ).toEqual({ ok: true, result: { ackedSeq: 2 } });
      expect(getTaskActivitySnapshot(originalTask.taskId)?.lastActivity).toBe(
        "Current owner progress",
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 1_001);
      try {
        oldWait.resolve({ status: "timeout" });
        await previousSettled.promise;
        expect(getTaskById(originalTask.taskId)?.status).toBe("timed_out");
        expect(previous.execution.outcome?.status).toBe("timeout");
        expect(terminalEvents).toEqual([]);
        expect(getAgentRunContextOwnerStatus(previous.runId, claimId, lifecycleGeneration)).toBe(
          "active",
        );
        expect(
          await reactivateCompletedSubagentSession({
            sessionKey: childSessionKey,
            runId: "timeout-successor",
          }),
        ).toBe(true);
        const successor = subagentRuns.get("timeout-successor")!;
        expect(successor.taskRunId).toBe(previous.runId);
        expect(getAgentRunContext(previous.runId)).toBe(owner);
        expect(getAgentRunContextOwnerStatus(previous.runId, claimId, lifecycleGeneration)).toBe(
          "active",
        );
        expect(getTaskById(originalTask.taskId)?.status).toBe("running");
        const terminalRequest = {
          runId: previous.runId,
          runEpoch: identity.ownerEpoch,
          seq: 3,
          lastAckedSeq: 2,
          event: {
            kind: "lifecycle",
            payload:
              phase === "end"
                ? { phase, startedAt, endedAt: Date.now() }
                : {
                    phase,
                    startedAt,
                    endedAt: Date.now(),
                    error: "predecessor failed",
                    fallbackExhaustedFailure: true,
                  },
          },
        } satisfies WorkerLiveEventParams;
        expect(identity.turnClaim).toBe(turnClaim);
        expect(placementGate.validateWorkerTurn(turnClaim)).toBe(true);
        expect(identity.runId).toBe(terminalRequest.runId);
        expect(Value.Check(WorkerLiveEventParamsSchema, terminalRequest)).toBe(true);
        expect(receiver.apply({ identity, request: terminalRequest })).toEqual({
          ok: true,
          result: { ackedSeq: 3 },
        });
        expect(terminalEvents).toEqual([previous.runId]);
        expect(subagentRuns.get(successor.runId)).toBe(successor);
        expect(successor.execution.status).toBe("running");
        reloadTaskRuntimeStateFromStore();
        expect.soft(getTaskById(originalTask.taskId)?.status).toBe("running");
        expect.soft(getTaskFlowById(originalTask.parentFlowId!)?.status).toBe("running");
        nextWait.resolve({
          status: "ok",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "successor completed" },
        });
        await successorSettled.promise;
        expect(getTaskById(originalTask.taskId)).toMatchObject({
          status: "succeeded",
          progressSummary: "successor completed",
        });
        expect(getTaskFlowById(originalTask.parentFlowId!)?.status).toBe("succeeded");
      } finally {
        clock.mockRestore();
      }
    } finally {
      stop();
      receiver.clear();
    }
  },
);

it.each(["successor", "task activation", "flow activation"] as const)(
  "restores a terminal predecessor when %s persistence rejects replacement",
  async (rejectedWrite) => {
    vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
    const childSessionKey = "agent:main:subagent:rearm-rollback";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "rearm-rollback-session",
    });
    registerSubagentRun({
      runId: "rollback-predecessor",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Resume interrupted work",
      cleanup: "keep",
      spawnMode: "session",
      expectsCompletionMessage: true,
      taskRowOwnership: "required",
    });
    const previous = subagentRuns.get("rollback-predecessor")!;
    const originalTask = findTaskByRunId(previous.runId)!;
    const error = "subagent run lost active execution context";
    expect(
      await finalizeInterruptedSubagentRun({
        runId: previous.runId,
        expectedEntry: previous,
        error,
      }),
    ).toBe(1);
    const terminalTask = getTaskById(originalTask.taskId)!;
    const flowId = terminalTask.parentFlowId!;
    expect(terminalTask.status).toBe("failed");
    expect(getTaskFlowById(flowId)?.status).toBe("failed");
    previous.collect = true;
    previous.swarmRequesterSessionKey = "agent:main:main";
    previous.requesterAgentId = "main";
    previous.groupId = "rollback-group";
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
    const parentEvents = vi.fn();
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.reason === "swarm") {
        parentEvents(event);
      }
    });
    const database = openOpenClawStateDatabase().db;
    const triggerName = `reject_replacement_${
      rejectedWrite === "successor" ? "run" : rejectedWrite === "task activation" ? "task" : "flow"
    }`;
    database.exec(
      rejectedWrite === "successor"
        ? `CREATE TEMP TRIGGER ${triggerName}
           BEFORE INSERT ON subagent_runs
           WHEN NEW.run_id = 'rollback-successor'
           BEGIN SELECT RAISE(ABORT, 'successor write rejected'); END`
        : rejectedWrite === "task activation"
          ? `CREATE TEMP TRIGGER ${triggerName}
             BEFORE UPDATE ON task_runs
             WHEN NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'task activation write rejected'); END`
          : `CREATE TEMP TRIGGER ${triggerName}
             BEFORE UPDATE ON flow_runs
             WHEN NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'flow activation write rejected'); END`,
    );
    try {
      expect
        .soft(
          replaceSubagentRunAfterSteerCore({
            previousRunId: previous.runId,
            nextRunId: "rollback-successor",
            expected: previous,
            allowEndedSource: true,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            persistenceFailure: "return-false",
          }),
        )
        .toBe(false);
    } finally {
      database.exec(`DROP TRIGGER ${triggerName}`);
      unsubscribe();
    }
    expect(parentEvents).not.toHaveBeenCalled();
    expect.soft(subagentRuns.get(previous.runId)).toBe(previous);
    expect.soft(subagentRuns.has("rollback-successor")).toBe(false);
    expect.soft(loadSubagentRegistryFromSqlite().has("rollback-successor")).toBe(false);
    expect
      .soft(loadSubagentRegistryFromSqlite().get(previous.runId)?.execution.status)
      .toBe("terminal");
    reloadTaskRuntimeStateFromStore();
    const restored = getTaskById(originalTask.taskId)!;
    expect(restored.detail).toMatchObject({ generation: previous.generation });
    expect.soft(restored.status).toBe("failed");
    expect.soft(restored.endedAt).toBe(terminalTask.endedAt);
    expect.soft(restored.error).toBe(error);
    expect.soft(getTaskFlowById(flowId)?.status).toBe("failed");
  },
);

it("rearms the canonical task and mirrored flow for an interrupted run's successor", async () => {
  vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
  const childSessionKey = "agent:main:subagent:interrupted-task";
  const requesterSessionKey = "agent:main:main";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "interrupted-task-session",
  });
  registerSubagentRun({
    runId: "interrupted-task-old",
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Resume interrupted work",
    cleanup: "keep",
    spawnMode: "session",
    expectsCompletionMessage: true,
    taskRowOwnership: "required",
  });
  const previous = subagentRuns.get("interrupted-task-old")!;
  const originalTask = findTaskByRunId(previous.runId)!;
  const flowId = originalTask.parentFlowId!;
  previous.taskRunId = undefined;
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
  const error = "subagent run lost active execution context";
  expect(
    await finalizeInterruptedSubagentRun({ runId: previous.runId, expectedEntry: previous, error }),
  ).toBe(1);
  expect(getTaskById(originalTask.taskId)).toMatchObject({ status: "failed", error });
  expect(getTaskFlowById(flowId)?.status).toBe("failed");
  expect(loadSubagentRegistryFromSqlite().get(previous.runId)).toEqual(previous);

  const observerSnapshots: Array<{ run?: string; task?: string; flow?: string }> = [];
  const unsubscribe = onSubagentRegistryPersisted(() => {
    observerSnapshots.push({
      run: subagentRuns.get("interrupted-task-new")?.execution.status,
      task: getTaskById(originalTask.taskId)?.status,
      flow: getTaskFlowById(flowId)?.status,
    });
  });
  try {
    expect(
      replaceSubagentRunAfterSteerCore({
        previousRunId: previous.runId,
        nextRunId: "interrupted-task-new",
        expected: previous,
        allowEndedSource: true,
        persistenceFailure: "throw",
      }),
    ).toBe(true);
  } finally {
    unsubscribe();
  }
  expect(observerSnapshots).toEqual([{ run: "running", task: "running", flow: "running" }]);
  const successor = subagentRuns.get("interrupted-task-new")!;
  expect(successor).toMatchObject({
    childSessionKey,
    requesterSessionKey,
    generation: previous.generation! + 1,
    execution: { status: "running" },
  });
  expect(successor.taskRunId).toBe(previous.runId);
  reloadTaskRuntimeStateFromStore();
  const task = getTaskById(originalTask.taskId)!;
  const flow = getTaskFlowById(flowId)!;
  expect(task).toMatchObject({
    runId: previous.runId,
    parentFlowId: flowId,
    ownerKey: requesterSessionKey,
    childSessionKey,
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect.soft(task.status).toBe("running");
  expect.soft(task.endedAt).toBeUndefined();
  expect.soft(task.error).toBeUndefined();
  expect.soft(task.cleanupAfter).toBeUndefined();
  expect.soft(task.deliveryStatus).toBe("pending");
  expect.soft(flow.status).toBe("running");
  expect.soft(flow.endedAt).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.sessionId).toBe(
    "interrupted-task-session",
  );
  expect(
    await finalizeInterruptedSubagentRun({ runId: previous.runId, expectedEntry: previous, error }),
  ).toBe(0);
  expect(subagentRuns.get(successor.runId)).toBe(successor);
  expect(getTaskById(originalTask.taskId)).toEqual(task);
  expect(getTaskFlowById(flowId)).toEqual(flow);

  const activityAt = task.lastEventAt! + 60_001;
  const clock = vi.spyOn(Date, "now").mockReturnValue(activityAt);
  try {
    emitAgentEvent({
      runId: successor.runId,
      sessionKey: childSessionKey,
      stream: "assistant",
      data: { text: "Resumed work is progressing" },
    });
    expect
      .soft(getTaskActivitySnapshot(task.taskId)?.lastActivity)
      .toBe("Resumed work is progressing");
    expect.soft(getTaskById(task.taskId)?.lastEventAt).toBe(activityAt);
    emitAgentEvent({
      runId: successor.runId,
      sessionKey: childSessionKey,
      stream: "tool",
      data: { phase: "start", name: "read" },
    });
    expect.soft(getTaskById(task.taskId)).toMatchObject({
      toolUseCount: 1,
      lastToolName: "read",
    });
    const currentActivity = getTaskActivitySnapshot(task.taskId);
    const currentTask = getTaskById(task.taskId);
    for (const event of [
      { stream: "assistant", data: { text: "Retired owner progress" } },
      { stream: "tool", data: { phase: "start", name: "write" } },
      { stream: "error", data: { error: "Retired owner error" } },
    ]) {
      emitAgentEvent({ runId: previous.runId, sessionKey: childSessionKey, ...event });
    }
    expect.soft(getTaskActivitySnapshot(task.taskId)).toEqual(currentActivity);
    expect.soft(getTaskById(task.taskId)).toEqual(currentTask);
  } finally {
    clock.mockRestore();
  }

  const staleFlow = failFlow({
    flowId,
    expectedRevision: getTaskFlowById(flowId)!.revision,
    endedAt: Date.now(),
  });
  expect(staleFlow.applied).toBe(true);
  expect(getTaskById(originalTask.taskId)?.status).toBe("running");
  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId: successor.runId,
      nextRunId: "interrupted-task-newer",
      expected: successor,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
  expect(getTaskFlowById(flowId)?.status).toBe("running");
});

it.each([
  { kind: "collector", collect: true },
  { kind: "non-collector", collect: false },
])(
  "advances a non-announcing $kind task with its replacement through completion",
  async ({ kind, collect }) => {
    const prefix = collect ? "silent-collector" : "silent-direct";
    const previousRunId = `${prefix}-predecessor`;
    const successorRunId = `${prefix}-successor`;
    const previousWait = createDeferred<AgentWaitResult>();
    const successorWait = createDeferred<AgentWaitResult>();
    vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      return (request.params as { runId: string }).runId === previousRunId
        ? await previousWait.promise
        : await successorWait.promise;
    });
    registerSubagentRun({
      runId: previousRunId,
      childSessionKey: `agent:main:subagent:${prefix}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: `Continue the ${kind} task`,
      cleanup: "keep",
      collect,
      ...(collect ? { groupId: prefix } : {}),
      expectsCompletionMessage: false,
      taskRowOwnership: "required",
    });
    const previous = subagentRuns.get(previousRunId)!;
    const originalTask = findTaskByRunId(previous.runId)!;
    const observerSnapshots: Array<{ generation?: number; delivery?: string; task?: string }> = [];
    const unsubscribe = onSubagentRegistryPersisted(() => {
      const successor = subagentRuns.get(successorRunId);
      const task = getTaskById(originalTask.taskId);
      observerSnapshots.push({
        generation: successor?.generation,
        delivery: successor?.delivery?.status,
        task: task?.status,
      });
    });
    try {
      expect(
        replaceSubagentRunAfterSteerCore({
          previousRunId: previous.runId,
          nextRunId: successorRunId,
          expected: previous,
          persistenceFailure: "throw",
        }),
      ).toBe(true);
    } finally {
      unsubscribe();
    }

    const successor = subagentRuns.get(successorRunId)!;
    expect(observerSnapshots).toEqual([
      {
        generation: previous.generation! + 1,
        delivery: "not_required",
        task: "running",
      },
    ]);
    expect(successor).toMatchObject({
      taskRunId: previous.runId,
      generation: previous.generation! + 1,
      delivery: { status: "not_required" },
    });
    const activatedTask = getTaskById(originalTask.taskId)!;
    expect(activatedTask).toMatchObject({
      taskId: originalTask.taskId,
      runId: previous.runId,
      parentFlowId: undefined,
      deliveryStatus: "not_applicable",
      detail: { runtime: "subagent", generation: successor.generation },
    });
    expect(loadTaskRegistryStateFromSqlite().tasks.get(originalTask.taskId)).toEqual(activatedTask);

    successorWait.resolve({ status: "ok", endedAt: Date.now() });
    await vi.waitFor(() => {
      expect(getTaskById(originalTask.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "not_applicable",
        detail: { generation: successor.generation },
      });
    });
  },
);

it("keeps non-announcing replacement authority through cold reopen and cancellation", () => {
  registerSubagentRun({
    runId: "silent-cold-predecessor",
    childSessionKey: "agent:main:subagent:silent-cold",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Continue after restart",
    cleanup: "keep",
    collect: false,
    expectsCompletionMessage: false,
    taskRowOwnership: "required",
  });
  const previous = subagentRuns.get("silent-cold-predecessor")!;
  const originalTask = findTaskByRunId(previous.runId)!;
  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId: previous.runId,
      nextRunId: "silent-cold-successor",
      expected: previous,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
  const generation = subagentRuns.get("silent-cold-successor")!.generation;

  coldReloadTaskOwnership();

  const restored = subagentRuns.get("silent-cold-successor")!;
  expect(restored).toMatchObject({
    taskRunId: previous.runId,
    generation,
    delivery: { status: "not_required" },
  });
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "running",
    deliveryStatus: "not_applicable",
    detail: { generation },
  });
  expect(markSubagentRunTerminated({ runId: restored.runId, reason: "killed" })).toBe(1);
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "cancelled",
    deliveryStatus: "not_applicable",
    detail: { generation },
  });
});

it("keeps plugin task and mirrored-flow ownership through replacement, success, and cold reopen", async () => {
  vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
  const previousRunId = "plugin-producer-predecessor";
  const successorRunId = "plugin-producer-successor";
  const previousWait = createDeferred<AgentWaitResult>();
  const successorWait = createDeferred<AgentWaitResult>();
  vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
    expect(request.method).toBe("agent.wait");
    return (request.params as { runId: string }).runId === previousRunId
      ? await previousWait.promise
      : await successorWait.promise;
  });

  await registerPluginSubagentRunFromGateway({
    cfg: getRuntimeConfig(),
    runId: previousRunId,
    childSessionKey: "agent:main:subagent:plugin-producer",
    task: "Complete plugin-owned background work",
    pluginId: "fixture",
    requester: {
      sessionKey: "agent:main:main",
      origin: { channel: "telegram", to: "fixture-chat" },
    },
  });
  const previous = subagentRuns.get(previousRunId)!;
  const originalTask = findTaskByRunId(previousRunId)!;
  const initialFlow = getTaskFlowById(originalTask.parentFlowId!)!;
  expect(previous.taskOwnershipPolicy).toBe("core_required");
  expect(initialFlow).toMatchObject({ syncMode: "task_mirrored", status: "running" });

  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId,
      nextRunId: successorRunId,
      expected: previous,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
  const successor = subagentRuns.get(successorRunId)!;
  const runningTask = getTaskById(originalTask.taskId)!;
  const runningFlow = getTaskFlowById(originalTask.parentFlowId!)!;
  expect(successor).toMatchObject({
    taskRunId: previousRunId,
    taskOwnershipPolicy: "core_required",
    generation: previous.generation! + 1,
  });
  expect(runningTask).toMatchObject({
    taskId: originalTask.taskId,
    runId: previousRunId,
    parentFlowId: initialFlow.flowId,
    status: "running",
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect(runningFlow).toMatchObject({
    flowId: initialFlow.flowId,
    syncMode: "task_mirrored",
    status: "running",
  });
  expect(runningFlow.revision).toBeGreaterThan(initialFlow.revision);

  successorWait.resolve({
    status: "ok",
    endedAt: Date.now(),
    terminalReply: { disposition: "visible", text: "plugin work complete" },
  });
  await vi.waitFor(() => {
    expect(getTaskById(originalTask.taskId)).toMatchObject({
      status: "succeeded",
      detail: { generation: successor.generation },
    });
    expect(getTaskFlowById(initialFlow.flowId)?.status).toBe("succeeded");
  });
  const terminalFlowRevision = getTaskFlowById(initialFlow.flowId)!.revision;

  coldReloadTaskOwnership();
  expect(subagentRuns.get(successorRunId)).toMatchObject({
    taskOwnershipPolicy: "core_required",
    generation: successor.generation,
  });
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "succeeded",
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect(getTaskFlowById(initialFlow.flowId)).toMatchObject({
    syncMode: "task_mirrored",
    revision: terminalFlowRevision,
    status: "succeeded",
  });
});

it("keeps visible-session task and mirrored-flow ownership through replacement, cancellation, and cold reopen", async () => {
  const previousRunId = "visible-producer-predecessor";
  const successorRunId = "visible-producer-successor";
  const childSessionKey = "agent:main:dashboard:visible-producer";
  const spawnResult = await maybeSpawnVisibleSession({
    raw: { visible: true },
    task: "Complete visible background work",
    label: "Visible producer",
    runtime: "subagent",
    sandbox: "inherit",
    expectsCompletionMessage: true,
    options: {
      agentSessionKey: "agent:main:main",
      requesterAgentIdOverride: "main",
      config: {
        agents: { list: [{ id: "main" }] },
        session: { mainKey: "main", scope: "per-sender" },
      },
      callGateway: vi.fn(async () => ({
        key: childSessionKey,
        sessionId: "visible-producer-session",
        entry: { lifecycleRevision: "visible-producer-revision" },
        runStarted: true,
        runId: previousRunId,
      })) as never,
      countActiveRuns: () => 0,
    },
  });
  expect(spawnResult).toMatchObject({ status: "accepted", childSessionKey, runId: previousRunId });

  const previous = subagentRuns.get(previousRunId)!;
  const originalTask = findTaskByRunId(previousRunId)!;
  const initialFlow = getTaskFlowById(originalTask.parentFlowId!)!;
  expect(previous.taskOwnershipPolicy).toBe("core_required");
  expect(initialFlow).toMatchObject({ syncMode: "task_mirrored", status: "running" });

  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId,
      nextRunId: successorRunId,
      expected: previous,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
  const successor = subagentRuns.get(successorRunId)!;
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "running",
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect(getTaskFlowById(initialFlow.flowId)).toMatchObject({
    syncMode: "task_mirrored",
    status: "running",
  });
  expect(markSubagentRunTerminated({ runId: successorRunId, reason: "killed" })).toBe(1);
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "cancelled",
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect(getTaskFlowById(initialFlow.flowId)?.status).toBe("cancelled");
  const terminalFlowRevision = getTaskFlowById(initialFlow.flowId)!.revision;

  coldReloadTaskOwnership();
  expect(subagentRuns.get(successorRunId)).toMatchObject({
    taskOwnershipPolicy: "core_required",
    generation: successor.generation,
  });
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "cancelled",
    detail: { runtime: "subagent", generation: successor.generation },
  });
  expect(getTaskFlowById(initialFlow.flowId)).toMatchObject({
    syncMode: "task_mirrored",
    revision: terminalFlowRevision,
    status: "cancelled",
  });
});

it.each(["successor", "task"] as const)(
  "rolls back non-announcing replacement when the %s write fails",
  (rejectedWrite) => {
    registerSubagentRun({
      runId: "silent-rollback-predecessor",
      childSessionKey: "agent:main:subagent:silent-rollback",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Keep the prior owner on failure",
      cleanup: "keep",
      collect: false,
      expectsCompletionMessage: false,
      taskRowOwnership: "required",
    });
    const previous = subagentRuns.get("silent-rollback-predecessor")!;
    const originalTask = findTaskByRunId(previous.runId)!;
    const database = openOpenClawStateDatabase().db;
    const trigger = `reject_silent_replacement_${rejectedWrite}`;
    database.exec(
      rejectedWrite === "successor"
        ? `CREATE TEMP TRIGGER ${trigger}
           BEFORE INSERT ON subagent_runs
           WHEN NEW.run_id = 'silent-rollback-successor'
           BEGIN SELECT RAISE(ABORT, 'successor write rejected'); END`
        : `CREATE TEMP TRIGGER ${trigger}
           BEFORE UPDATE ON task_runs
           WHEN NEW.task_id = '${originalTask.taskId}'
           BEGIN SELECT RAISE(ABORT, 'task write rejected'); END`,
    );
    try {
      expect(
        replaceSubagentRunAfterSteerCore({
          previousRunId: previous.runId,
          nextRunId: "silent-rollback-successor",
          expected: previous,
          persistenceFailure: "return-false",
        }),
      ).toBe(false);
    } finally {
      database.exec(`DROP TRIGGER ${trigger}`);
    }
    expect(subagentRuns.get(previous.runId)).toBe(previous);
    expect(subagentRuns.has("silent-rollback-successor")).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(previous.runId)).toEqual(previous);
    expect(loadSubagentRegistryFromSqlite().has("silent-rollback-successor")).toBe(false);
    expect(getTaskById(originalTask.taskId)).toEqual(originalTask);
    expect(loadTaskRegistryStateFromSqlite().tasks.get(originalTask.taskId)).toEqual(originalTask);
  },
);

it("leaves non-announcing replacement task ownership to a custom runtime", () => {
  const runtime = getDetachedTaskLifecycleRuntime();
  const createRunningTaskRun = vi.fn(
    (params: Parameters<typeof runtime.createRunningTaskRun>[0]) => {
      const task = runtime.createRunningTaskRun(params);
      return task ? { ...task } : null;
    },
  );
  setDetachedTaskLifecycleRuntime({
    ...runtime,
    createRunningTaskRun,
    findTaskRun: undefined,
  });
  registerSubagentRun({
    runId: "custom-silent-predecessor",
    childSessionKey: "agent:main:subagent:custom-silent",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Custom runtime task",
    cleanup: "keep",
    collect: false,
    expectsCompletionMessage: false,
    taskRowOwnership: "required",
  });
  const previous = subagentRuns.get("custom-silent-predecessor")!;
  const originalTask = findTaskByRunId(previous.runId)!;
  expect(createRunningTaskRun).toHaveBeenCalledOnce();
  expect(previous.taskOwnershipPolicy).toBe("custom");

  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId: previous.runId,
      nextRunId: "custom-silent-successor",
      expected: previous,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
  expect(subagentRuns.get("custom-silent-successor")).toMatchObject({
    generation: previous.generation! + 1,
    delivery: { status: "not_required" },
  });
  expect(getTaskById(originalTask.taskId)).toEqual(originalTask);
  expect(loadTaskRegistryStateFromSqlite().tasks.get(originalTask.taskId)).toEqual(originalTask);
});
