// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { persistSubagentRunsToDiskOrThrow, useSubagentControlFixture } from "./subagent-control.test-support.js";
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
import { getAgentEventLifecycleGeneration, onAgentEvent } from "../../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunContextOwnerStatus,
} from "../../../infra/agent-run-registry.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
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
    await registerSubagentRun({
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
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const placementStore = createWorkerSessionPlacementStore();
    const placementIdentity = { sessionId, sessionKey: childSessionKey, agentId: "main" };
    seedAttachedPlacementEnvironment(openOpenClawStateDatabase(), {
      environmentId: "timeout-worker",
      sessionId,
      ownerEpoch: 1,
    });
    let placement = await placementStore.startDispatch(placementIdentity);
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
    const turnClaim = await placementStore.claimTurn({
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
    const receiver = createWorkerLiveEventReceiver();
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
      expect(
        await receiver.apply({ identity, source, request: startRequest, readAckedSeq: () => 0 }),
      ).toEqual({
        ok: true,
        result: { ackedSeq: 1 },
      });
      const claimId = getAgentRunContextOwnership(previous.runId)!.exclusiveClaimId!;
      const owner = getAgentRunContext(previous.runId)!;
      expect(claimId).toBeDefined();
      expect(
        await receiver.apply({
          readAckedSeq: () => 0,
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
      const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 1_001);
      try {
        oldWait.resolve({ status: "timeout" });
        await previousSettled.promise;
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
        expect(
          await receiver.apply({
            identity,
            source,
            request: terminalRequest,
            readAckedSeq: () => 0,
          }),
        ).toEqual({
          ok: true,
          result: { ackedSeq: 3 },
        });
        expect(terminalEvents).toEqual([previous.runId]);
        expect(subagentRuns.get(successor.runId)).toBe(successor);
        expect(successor.execution.status).toBe("running");
        nextWait.resolve({
          status: "ok",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "successor completed" },
        });
        await successorSettled.promise;
      } finally {
        clock.mockRestore();
      }
    } finally {
      stop();
      receiver.clear();
    }
  },
);

it.each(["successor", "source retirement"] as const)(
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
    await registerSubagentRun({
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
    const error = "subagent run lost active execution context";
    expect(
      await finalizeInterruptedSubagentRun({
        runId: previous.runId,
        expectedEntry: previous,
        error,
      }),
    ).toBe(1);
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
    const triggerName = "reject_native_replacement";
    database.exec(
      rejectedWrite === "successor"
        ? "CREATE TEMP TRIGGER reject_native_replacement BEFORE INSERT ON subagent_runs WHEN NEW.run_id = 'rollback-successor' BEGIN SELECT RAISE(ABORT, 'successor write rejected'); END"
        : "CREATE TEMP TRIGGER reject_native_replacement BEFORE DELETE ON subagent_runs WHEN OLD.run_id = 'rollback-predecessor' BEGIN SELECT RAISE(ABORT, 'source retirement rejected'); END",
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
  },
);

it("rearms native execution for an interrupted run's successor", async () => {
  fixture.announce.mockResolvedValue("delivered");
  const childSessionKey = "agent:main:subagent:interrupted-task";
  const requesterSessionKey = "agent:main:main";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "interrupted-task-session",
  });
  await registerSubagentRun({
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
  previous.taskRunId = undefined;
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
  const error = "subagent run lost active execution context";
  expect(
    await finalizeInterruptedSubagentRun({ runId: previous.runId, expectedEntry: previous, error }),
  ).toBe(1);
  expect(loadSubagentRegistryFromSqlite().get(previous.runId)).toEqual(previous);

  const observerSnapshots: Array<{ run?: string }> = [];
  const unsubscribe = onSubagentRegistryPersisted(() => {
    observerSnapshots.push({
      run: subagentRuns.get("interrupted-task-new")?.execution.status,
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
  expect(observerSnapshots).toEqual([{ run: "running" }]);
  const successor = subagentRuns.get("interrupted-task-new")!;
  expect(successor).toMatchObject({
    childSessionKey,
    requesterSessionKey,
    generation: previous.generation! + 1,
    execution: { status: "running" },
  });
  expect(successor.taskRunId).toBe(previous.runId);
  expect(loadSubagentRegistryFromSqlite().get(successor.runId)).toEqual(successor);
  expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.sessionId).toBe(
    "interrupted-task-session",
  );
  expect(
    await finalizeInterruptedSubagentRun({ runId: previous.runId, expectedEntry: previous, error }),
  ).toBe(0);
  expect(subagentRuns.get(successor.runId)).toBe(successor);

  expect(
    replaceSubagentRunAfterSteerCore({
      previousRunId: successor.runId,
      nextRunId: "interrupted-task-newer",
      expected: successor,
      persistenceFailure: "throw",
    }),
  ).toBe(true);
});
