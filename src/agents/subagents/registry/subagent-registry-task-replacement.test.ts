// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  persistSubagentRunsToDiskOrThrow,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import {
  WorkerLiveEventParamsSchema,
  type WorkerLiveEventParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import type { WorkerConnectionIdentity } from "../../../gateway/worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "../../../gateway/worker-environments/live-events.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "../../../gateway/worker-environments/placement-worker-gate.js";
import { resolveWorkerTurnTranscriptTarget } from "../../../gateway/worker-environments/worker-turn-transcript-target.js";
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
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { reloadTaskRuntimeStateFromStore } from "../../../tasks/runtime-internal.js";
import { failFlow, getTaskFlowById } from "../../../tasks/task-flow-registry.js";
import { getTaskActivitySnapshot } from "../../../tasks/task-registry-activity.js";
import { findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { finalizeInterruptedSubagentRun } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

it.each(["end", "error"] as const)(
  "keeps a timeout successor running when its exact predecessor owner publishes its first %s terminal",
  async (phase) => {
    fixture.announce.mockResolvedValue("delivered");
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
    fixture.gateway.mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      return (request.params as { runId: string }).runId === "timeout-predecessor"
        ? await oldWait.promise
        : await nextWait.promise;
    });
    const childSessionKey = "agent:main:subagent:late-owner-terminal";
    const sessionId = "late-owner-terminal-session";
    const storePath = await writeSubagentSessionEntry({
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
    const entry = loadSessionEntry({ agentId: "main", storePath, sessionKey: childSessionKey });
    if (!entry) {
      throw new Error("expected worker session entry");
    }
    const sessionTarget = {
      ...placementIdentity,
      storePath,
      expectedLifecycleRevision: entry.lifecycleRevision,
      expectedWriterRunId: entry.activeWriterRunId,
    };
    const source = {
      sessionTarget,
      receiptAuthority: () => {
        if (!placementGate.validateWorkerTurn(turnClaim)) {
          throw new Error("worker turn was revoked");
        }
        resolveWorkerTurnTranscriptTarget({ ...sessionTarget, sessionTarget });
      },
    };
    const receiver = createWorkerLiveEventReceiver({
      startupBindings: [
        { sessionId, environmentId: identity.environmentId, runEpoch: identity.ownerEpoch },
      ],
      startupOwners: new Map([[identity.environmentId, identity.ownerEpoch]]),
    });
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
      expect(await receiver.apply({ identity, source, request: startRequest })).toEqual({
        ok: true,
        result: { ackedSeq: 1 },
      });
      const claimId = getAgentRunContextOwnership(previous.runId)!.exclusiveClaimId!;
      const owner = getAgentRunContext(previous.runId)!;
      expect(claimId).toBeDefined();
      expect(
        await receiver.apply({
          identity,
          source,
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
        expect(await receiver.apply({ identity, source, request: terminalRequest })).toEqual({
          ok: true,
          result: { ackedSeq: 3 },
        });
        expect(terminalEvents).toEqual([previous.runId]);
        expect(subagentRuns.get(successor.runId)).toBe(successor);
        expect(successor.execution.status).toBe("running");
        await reloadTaskRuntimeStateFromStore();
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
    fixture.announce.mockResolvedValue("delivered");
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
    await reloadTaskRuntimeStateFromStore();
    const restored = getTaskById(originalTask.taskId)!;
    expect(restored.detail).toMatchObject({ generation: previous.generation });
    expect.soft(restored.status).toBe("failed");
    expect.soft(restored.endedAt).toBe(terminalTask.endedAt);
    expect.soft(restored.error).toBe(error);
    expect.soft(getTaskFlowById(flowId)?.status).toBe("failed");
  },
);

it("rearms the canonical task and mirrored flow for an interrupted run's successor", async () => {
  fixture.announce.mockResolvedValue("delivered");
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
  await settleSubagentRegistryPersistenceWork();
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
  await reloadTaskRuntimeStateFromStore();
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
