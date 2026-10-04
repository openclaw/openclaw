// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { Value } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  WorkerLiveEventParamsSchema,
  type WorkerLiveEventParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import type { WorkerConnectionIdentity } from "../../../gateway/worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "../../../gateway/worker-environments/live-events.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../../../gateway/worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "../../../gateway/worker-environments/placement-worker-gate.js";
import { resolveWorkerTurnTranscriptTarget } from "../../../gateway/worker-environments/worker-turn-transcript-target.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunContextOwnerStatus,
} from "../../../infra/agent-run-registry.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as hookRunnerGlobal from "../../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as persistence from "./subagent-registry-persistence.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  finalizeInterruptedSubagentRun,
  releaseSubagentRun,
} from "./subagent-registry.test-helpers.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

const fixture = useSubagentControlFixture();

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });
vi.mock("../../../plugins/hook-runner-global.js", { spy: true });

it("does not recreate a source released before replacement admission", async () => {
  await registerSubagentRun({
    runId: "released-source",
    childSessionKey: "agent:main:subagent:released-source",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "original task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
  });
  const entered = createDeferred();
  const release = createDeferred();
  fixture.worker.mockImplementationOnce((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, executeOptions) => {
            const receipt = await scope.execute(command, executeOptions);
            entered.resolve();
            await release.promise;
            return receipt;
          },
        }),
      options,
    ),
  );
  const retiring = releaseSubagentRun("released-source");
  let replacing: Promise<boolean> | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, retiring, "release did not reach native ACK");
    replacing = replaceSubagentRunAfterSteerCore({
      previousRunId: "released-source",
      nextRunId: "must-not-revive",
    });
    release.resolve();
    await retiring;
    expect(await replacing).toBe(false);
    expect(subagentRuns.has("released-source")).toBe(false);
    expect(subagentRuns.has("must-not-revive")).toBe(false);
    expect(loadSubagentRegistryFromSqlite().has("must-not-revive")).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([retiring, replacing]);
  }
});

it("hydrates a cold durable source before advancing its replacement generation", async () => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const childSessionKey = "agent:main:subagent:cold-replacement";
  await registerSubagentRun({
    runId: "cold-original",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "restored replacement source",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
  });
  expect(
    await replaceSubagentRunAfterSteerCore({
      previousRunId: "cold-original",
      nextRunId: "cold-predecessor",
    }),
  ).toBe(true);
  await mutateSubagentRuns(["cold-predecessor"], (rows) => {
    const source = rows.get("cold-predecessor");
    if (!source) {
      throw new Error("Missing cold source fixture");
    }
    return {
      value: undefined,
      postimages: new Map([
        [
          source.runId,
          {
            ...source,
            execution: {
              ...source.execution,
              status: "terminal" as const,
              endedAt: Date.now(),
              outcome: { status: "ok" as const },
            },
          },
        ],
      ]),
    };
  });
  // Evict only the resident value; its canonical row remains the replacement source.
  subagentRuns.delete("cold-predecessor");
  expect(loadSubagentRegistryFromSqlite().get("cold-predecessor")?.generation).toBe(2);
  expect(
    await reactivateCompletedSubagentSession({
      sessionKey: childSessionKey,
      runId: "cold-successor",
    }),
  ).toBe(true);
  expect(subagentRuns.get("cold-successor")).toMatchObject({
    generation: 3,
    taskRunId: "cold-successor",
    execution: { status: "running" },
  });
  const stored = loadSubagentRegistryFromSqlite();
  expect(stored.get("cold-predecessor")?.execution.suppressSessionEffects).toBe(true);
  expect(stored.get("cold-successor")?.generation).toBe(3);
});

it.each(["transaction", "commit"] as const)(
  "rejects replacement lifecycle retirement at native %s admission",
  async (stage) => {
    await registerSubagentRun({
      runId: "lifecycle-predecessor",
      childSessionKey: "agent:main:subagent:lifecycle-replacement",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "original task",
      cleanup: "keep",
      retainAttachmentsOnKeep: true,
    });
    const source = subagentRuns.get("lifecycle-predecessor")!;
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    let rotated = false;
    const admission = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === stage && !rotated) {
            rotated = true;
            rotateAgentEventLifecycleGeneration();
          }
          admit(request, grant);
        }, attachment),
      );
    try {
      await expect(
        replaceSubagentRunAfterSteerCore({
          previousRunId: source.runId,
          nextRunId: "retired-successor",
        }),
      ).rejects.toMatchObject({ outcome: "not-committed" });
      expect(rotated).toBe(true);
      expect(subagentRuns.get(source.runId)).toBe(source);
      expect(subagentRuns.has("retired-successor")).toBe(false);
      expect(loadSubagentRegistryFromSqlite().has(source.runId)).toBe(true);
      expect(loadSubagentRegistryFromSqlite().has("retired-successor")).toBe(false);
    } finally {
      admission.mockRestore();
    }
  },
);

it.each(["end", "error"] as const)(
  "keeps a timeout successor running when its exact predecessor owner publishes its first %s terminal",
  async (phase) => {
    fixture.announce.mockResolvedValue("delivered");
    const oldWait = createDeferred<AgentWaitResult>();
    const nextWait = createDeferred<AgentWaitResult>();
    const previousSettled = createDeferred();
    const successorSettled = createDeferred();
    onTestFinished(
      subscribeSubagentRunChanges("persistence", () => {
        if (typeof subagentRuns.get("timeout-predecessor")?.cleanupCompletedAt === "number") {
          previousSettled.resolve();
        }
        if (typeof subagentRuns.get("timeout-successor")?.cleanupCompletedAt === "number") {
          successorSettled.resolve();
        }
      }),
    );
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
      placement = await placementStore.transition({
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
        expect(subagentRuns.get(previous.runId)?.execution.outcome?.status).toBe("timeout");
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
        expect(successor.taskRunId).toBe(successor.runId);
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
    await fixture.settle();
    await mutateSubagentRuns([previous.runId], (rows) => ({
      value: undefined,
      postimages: new Map([
        [
          previous.runId,
          {
            ...rows.get(previous.runId)!,
            collect: true,
            swarmRequesterSessionKey: "agent:main:main",
            requesterAgentId: "main",
            groupId: "rollback-group",
          },
        ],
      ]),
    }));
    const terminal = subagentRuns.get(previous.runId)!;
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
        ? "CREATE TRIGGER reject_native_replacement BEFORE INSERT ON subagent_runs WHEN NEW.run_id = 'rollback-successor' BEGIN SELECT RAISE(ABORT, 'successor write rejected'); END"
        : "CREATE TRIGGER reject_native_replacement BEFORE DELETE ON subagent_runs WHEN OLD.run_id = 'rollback-predecessor' BEGIN SELECT RAISE(ABORT, 'source retirement rejected'); END",
    );
    const worker = vi.mocked(stateWorker.runOpenClawStateWorkerOperation);
    const priorOperations = worker.mock.results.length;
    try {
      expect
        .soft(
          await replaceSubagentRunAfterSteerCore({
            previousRunId: previous.runId,
            nextRunId: "rollback-successor",
            expected: terminal,
            allowEndedSource: true,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          }),
        )
        .toBe(false);
      const results = await Promise.allSettled(
        worker.mock.results
          .slice(priorOperations)
          .flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
      expect(results).toContainEqual({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining(
            rejectedWrite === "successor"
              ? "successor write rejected"
              : "source retirement rejected",
          ),
        }),
      });
    } finally {
      database.exec(`DROP TRIGGER ${triggerName}`);
      unsubscribe();
    }
    expect(parentEvents).not.toHaveBeenCalled();
    expect.soft(subagentRuns.get(previous.runId)).toEqual(terminal);
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
  await mutateSubagentRuns(["interrupted-task-old"], (rows) => ({
    value: undefined,
    postimages: new Map([
      [
        "interrupted-task-old",
        {
          ...rows.get("interrupted-task-old")!,
          taskRunId: undefined,
        },
      ],
    ]),
  }));
  const previous = subagentRuns.get("interrupted-task-old")!;
  const error = "subagent run lost active execution context";
  expect(
    await finalizeInterruptedSubagentRun({ runId: previous.runId, expectedEntry: previous, error }),
  ).toBe(1);
  await fixture.settle();
  expect(loadSubagentRegistryFromSqlite().get(previous.runId)).toEqual(
    subagentRuns.get(previous.runId),
  );

  const observerSnapshots: Array<{ run?: string }> = [];
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    observerSnapshots.push({
      run: subagentRuns.get("interrupted-task-new")?.execution.status,
    });
  });
  try {
    expect(
      await replaceSubagentRunAfterSteerCore({
        previousRunId: previous.runId,
        nextRunId: "interrupted-task-new",
        expected: previous,
        allowEndedSource: true,
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
    await replaceSubagentRunAfterSteerCore({
      previousRunId: successor.runId,
      nextRunId: "interrupted-task-newer",
      expected: successor,
    }),
  ).toBe(true);
});

it("admits a child follow-up while its predecessor's browser cleanup is still pending", async () => {
  const predecessorWait = createDeferred<AgentWaitResult>();
  const cleanupEntered = createDeferred();
  const releaseCleanup = createDeferred();
  fixture.gateway.mockImplementationOnce(async () => predecessorWait.promise);
  fixture.cleanup.mockImplementationOnce(async () => {
    cleanupEntered.resolve();
    await releaseCleanup.promise;
  });
  fixture.announce.mockResolvedValue("delivered");
  const childSessionKey = "agent:main:subagent:held-browser-cleanup";
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "held-browser-cleanup-session",
  });
  try {
    await registerSubagentRun({
      runId: "browser-cleanup-predecessor",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Finish browser work",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    predecessorWait.resolve({
      status: "ok",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Browser work completed" },
    });
    await cleanupEntered.promise;
    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "browser-cleanup-successor",
        task: "Continue with the next task",
      }),
    ).resolves.toBe(true);
    const stored = loadSubagentRegistryFromSqlite();
    expect(stored.get("browser-cleanup-predecessor")).toMatchObject({
      task: "Finish browser work",
      execution: {
        status: "terminal",
        outcome: { status: "ok" },
        suppressSessionEffects: true,
      },
    });
    expect(stored.get("browser-cleanup-successor")).toMatchObject({
      task: "Continue with the next task",
      execution: { status: "running" },
    });
  } finally {
    releaseCleanup.resolve();
    await fixture.settle();
  }
  expect(fixture.cleanup).toHaveBeenCalledOnce();
  expect(subagentRuns.get("browser-cleanup-successor")?.execution.status).toBe("running");
  expect(loadSubagentRegistryFromSqlite().get("browser-cleanup-successor")?.execution.status).toBe(
    "running",
  );
});

it.each([
  "committed",
  "caller retired",
  "source replaced",
  "stamp admitted during wait",
  "caller retired during late stamp",
  "source replaced during late stamp",
  "cleanup admitted during wait",
] as const)(
  "settles the predecessor's admitted writes before follow-up publication (%s)",
  async (transition) => {
    const { runOpenClawStateWorkerOperation: runWorker } = await vi.importActual<
      typeof import("../../../state/openclaw-state-worker-store.js")
    >("../../../state/openclaw-state-worker-store.js");
    const childSessionKey = "agent:main:subagent:pending-ended-hook";
    await registerSubagentRun({
      runId: "pending-ended-hook",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "original work",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    await mutateSubagentRuns(["pending-ended-hook"], (rows) => ({
      value: undefined,
      postimages: new Map([
        [
          "pending-ended-hook",
          {
            ...rows.get("pending-ended-hook")!,
            execution: {
              status: "terminal" as const,
              startedAt: 1,
              endedAt: 2,
              outcome: { status: "ok" as const },
            },
            completion: { required: false, resultText: "done", capturedAt: 2 },
          },
        ],
      ]),
    }));
    const original = subagentRuns.get("pending-ended-hook")!;
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
      createHookRunner(createEmptyPluginRegistry()),
    );
    const cleanup = createSubagentRegistryContextCleanup({
      isEndedHookOwnerCurrent: (id, entry) => isSameSubagentRunOwner(subagentRuns.get(id), entry),
      warn: () => {},
    });
    const lateStamp =
      transition.includes("late stamp") || transition === "stamp admitted during wait";
    const lateCleanup = transition === "cleanup admitted during wait";
    const lateWrite = lateStamp || lateCleanup;
    const callerRetired = transition.startsWith("caller retired");
    const sourceReplaced = transition.startsWith("source replaced");
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const secondAdmitted = createDeferred();
    const entered = createDeferred();
    const release = createDeferred();
    const followupEntered = createDeferred();
    let holdFirst = lateWrite;
    let holdStamp = true;
    const mutate = persistence.mutateSubagentRuns;
    let mutationCount = 0;
    const observeMutation: typeof mutate = (ids, plan, options) => {
      const result = mutate(ids, plan, options);
      if (ids.length === 1 && ids[0] === original.runId && ++mutationCount === 2) {
        secondAdmitted.resolve();
      }
      return result;
    };
    vi.spyOn(persistence, "mutateSubagentRuns").mockImplementation(observeMutation);
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, options) =>
        runWorker(
          context,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                if (command.type === "subagents.persistChanges") {
                  if (holdFirst) {
                    holdFirst = false;
                    firstEntered.resolve();
                    await releaseFirst.promise;
                  } else if (holdStamp) {
                    holdStamp = false;
                    if (lateCleanup) {
                      const receipt = await scope.execute(command, executeOptions);
                      entered.resolve();
                      await release.promise;
                      return receipt;
                    }
                    entered.resolve();
                    await release.promise;
                  }
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
    );
    await import("./subagent-registry.js");
    let firstWrite: Promise<void> | undefined;
    let hook: Promise<unknown> | undefined;
    let followup: Promise<unknown> | undefined;
    let callerCurrent = true;
    try {
      if (lateWrite) {
        firstWrite = mutateSubagentRuns([original.runId], (rows) => ({
          value: undefined,
          postimages: new Map([
            [original.runId, { ...rows.get(original.runId)!, label: "prepared" }],
          ]),
        }));
        await awaitGateBeforeSettlement(
          firstEntered.promise,
          firstWrite,
          "First write never entered worker",
        );
      }
      hook = lateCleanup
        ? mutateSubagentRuns([original.runId], (rows) => ({
            value: undefined,
            postimages: new Map([
              [original.runId, { ...rows.get(original.runId)!, cleanupCompletedAt: 3 }],
            ]),
          }))
        : cleanup.emitSubagentEndedHookForRun({ entry: original });
      if (lateWrite) {
        await awaitGateBeforeSettlement(
          secondAdmitted.promise,
          hook,
          "Predecessor write never admitted",
        );
      } else {
        await awaitGateBeforeSettlement(
          entered.promise,
          hook,
          "Predecessor write never entered worker",
        );
      }
      expect(
        loadSubagentRegistryFromSqlite().get(original.runId)?.endedHookEmittedAt,
      ).toBeUndefined();
      let settled = false;
      followup = reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "after-ended-hook",
        task: "follow-up work",
        assertCurrent: () => {
          followupEntered.resolve();
          if (!callerCurrent) {
            throw new Error("follow-up caller retired");
          }
        },
      }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      await awaitGateBeforeSettlement(
        followupEntered.promise,
        followup,
        "Follow-up never checked its caller",
      );
      if (lateWrite) {
        releaseFirst.resolve();
        await firstWrite;
        await awaitGateBeforeSettlement(
          entered.promise,
          hook,
          "Predecessor write never reached worker",
        );
      }
      expect(settled).toBe(false);
      if (lateCleanup) {
        expect(subagentRuns.get(original.runId)?.cleanupCompletedAt).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().get(original.runId)?.cleanupCompletedAt).toBe(3);
      }
      if (callerRetired) {
        callerCurrent = false;
      } else if (sourceReplaced) {
        const replacement = structuredClone(subagentRuns.get(original.runId)!);
        replacement.generation = original.generation! + 1;
        replacement.task = "replacement owner";
        // An independent writer changes the durable execution while the worker is held.
        writeSubagentRunValuesInDatabase(
          openOpenClawStateDatabase(),
          [bindSubagentRunRecord(replacement)],
          [],
        );
      }
      release.resolve();
      await hook;
      if (callerRetired || sourceReplaced) {
        expect(await followup).toMatchObject({
          error: new Error(
            callerRetired
              ? "follow-up caller retired"
              : "subagent follow-up source changed while its writes settled",
          ),
        });
        const stored = loadSubagentRegistryFromSqlite();
        expect(stored.has("after-ended-hook")).toBe(false);
        expect(stored.get(original.runId)?.task).toBe(
          sourceReplaced ? "replacement owner" : "original work",
        );
      } else {
        expect(await followup).toEqual({ value: true });
        const stored = loadSubagentRegistryFromSqlite();
        expect(stored.get("after-ended-hook")).toMatchObject({
          task: "follow-up work",
          generation: original.generation! + 1,
          execution: { status: "running" },
        });
        expect(stored.get(original.runId)).toMatchObject({
          task: "original work",
          generation: original.generation,
          execution: { status: "terminal", suppressSessionEffects: true },
          ...(lateCleanup ? { cleanupCompletedAt: 3 } : { endedHookEmittedAt: expect.any(Number) }),
          ...(lateWrite ? { label: "prepared" } : {}),
        });
      }
    } finally {
      releaseFirst.resolve();
      release.resolve();
      await Promise.allSettled([firstWrite, hook, followup]);
    }
  },
);
