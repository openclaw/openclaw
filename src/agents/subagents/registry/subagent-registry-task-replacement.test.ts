// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { persistSubagentRunsToDiskOrThrow, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { setImmediate } from "node:timers/promises";
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
import * as hookRunnerGlobal from "../../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { finalizeInterruptedSubagentRun } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });
vi.mock("../../../plugins/hook-runner-global.js", { spy: true });

it.each(["end", "error"] as const)(
  "keeps a terminal-timeout successor running when its exact predecessor owner publishes its first %s terminal",
  async (phase) => {
    fixture.announce.mockResolvedValue("delivered");
    const oldWait = createDeferred<AgentWaitResult>();
    const nextWait = createDeferred<AgentWaitResult>();
    const previousSettled = createDeferred();
    const successorSettled = createDeferred();
    fixture.persist.mockImplementation((runs, ...params) => {
      persistSubagentRunsToDiskOrThrow(runs, ...params);
      // Live rows publish after this callback returns; observe the committed snapshot.
      if (typeof runs.get("timeout-predecessor")?.cleanupCompletedAt === "number") {
        previousSettled.resolve();
      }
      if (typeof runs.get("timeout-successor")?.cleanupCompletedAt === "number") {
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
        // This fixture requires an actual completed timeout before replacement.
        // A bare parent-wait expiry now leaves the predecessor nonterminal.
        oldWait.resolve({ status: "timeout", endedAt: Date.now() });
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
  await fixture.settle();
  expect(loadSubagentRegistryFromSqlite().get(previous.runId)).toEqual(previous);

  const observerSnapshots: Array<{ run?: string }> = [];
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
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
    }),
  ).toBe(true);
});

it("admits a child follow-up while its predecessor's browser cleanup is still pending", async () => {
  const { persistSubagentRunsToDiskAsyncOrThrow } = await vi.importActual<
    typeof import("./subagent-registry-state.js")
  >("./subagent-registry-state.js");
  const registryState = await import("./subagent-registry-state.js");
  vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    persistSubagentRunsToDiskAsyncOrThrow,
  );
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
    expect(stored.has("browser-cleanup-predecessor")).toBe(false);
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
  "settles the predecessor's pending writes before follow-up admission (%s)",
  async (transition) => {
    const { persistSubagentRunsToDiskAsyncOrThrow } = await vi.importActual<
      typeof import("./subagent-registry-state.js")
    >("./subagent-registry-state.js");
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
    const original = subagentRuns.get("pending-ended-hook")!;
    original.execution = {
      status: "terminal",
      startedAt: 1,
      endedAt: 2,
      outcome: { status: "ok" },
    };
    original.completion = { required: false, resultText: "done", capturedAt: 2 };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [original.runId]);
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
      createHookRunner(createEmptyPluginRegistry()),
    );
    const cleanup = createSubagentRegistryContextCleanup({
      persist: (...ids) => persistSubagentRunsToDiskOrThrow(subagentRuns, ids),
      persistAsyncOrThrow: (context, callbacks, ...ids) =>
        persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, { context, ...callbacks }),
      isEndedHookOwnerCurrent: (id, entry) => subagentRuns.get(id) === entry,
      warn: () => {},
    });
    const lateStamp =
      transition === "stamp admitted during wait" ||
      transition === "caller retired during late stamp" ||
      transition === "source replaced during late stamp";
    const lateCleanup = transition === "cleanup admitted during wait";
    const lateWrite = lateStamp || lateCleanup;
    const callerRetired =
      transition === "caller retired" || transition === "caller retired during late stamp";
    const sourceReplaced =
      transition === "source replaced" || transition === "source replaced during late stamp";
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const producerWait = createDeferred();
    const capturedWait = createDeferred();
    const additionalWait = createDeferred();
    const entered = createDeferred();
    const release = createDeferred();
    let holdFirst = lateWrite;
    let holdStamp = true;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      async (context, operation, options) => {
        if (holdFirst) {
          holdFirst = false;
          firstEntered.resolve();
          await releaseFirst.promise;
        } else if (holdStamp && lateCleanup) {
          holdStamp = false;
          return runWorker(
            context,
            (scope) =>
              operation({
                async execute(command, executeOptions) {
                  const receipt = await scope.execute(command, executeOptions);
                  // The native cleanup commit precedes its live-row publication.
                  entered.resolve();
                  await release.promise;
                  return receipt;
                },
              }),
            options,
          );
        } else if (holdStamp && original.endedHookEmittedAt !== undefined) {
          holdStamp = false;
          entered.resolve();
          await release.promise;
        }
        return runWorker(context, operation, options);
      },
    );
    await import("./subagent-registry.js");
    let hook = lateWrite ? undefined : cleanup.emitSubagentEndedHookForRun({ entry: original });
    let firstWrite: Promise<void> | undefined;
    let restoreWaitObserver: (() => void) | undefined;
    let capturedPending = false;
    let observedWaits = 0;
    let followup: Promise<unknown> | undefined;
    let callerCurrent = true;
    try {
      if (lateWrite) {
        const persistence = await import("./subagent-registry-persistence.js");
        const { captureOpenClawStateWorkerContext } =
          await import("../../../state/openclaw-state-worker-context.js");
        const waitForPending = persistence.waitForPendingSubagentRegistryWrites;
        const observation = vi
          .spyOn(persistence, "waitForPendingSubagentRegistryWrites")
          .mockImplementation((runIds, admission) => {
            const pending = waitForPending(runIds, admission);
            if (runIds.includes(original.runId)) {
              capturedPending = pending !== undefined;
              observedWaits += 1;
              if (observedWaits === 1) {
                producerWait.resolve();
              } else {
                capturedWait.resolve();
              }
              if (lateCleanup && observedWaits === 2 && pending) {
                // Resume the first follow-up wait after the next write commits,
                // while that write still owns its unpublished receipt.
                return pending.then(() => entered.promise);
              }
              if (lateCleanup && observedWaits > 2) {
                additionalWait.resolve();
              }
            }
            return pending;
          });
        restoreWaitObserver = () => observation.mockRestore();
        // Let the next writer and follow-up capture the same earlier write, in that order.
        firstWrite = persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [original.runId], {
          context: captureOpenClawStateWorkerContext(),
        });
        void firstWrite.catch(() => {});
        await firstEntered.promise;
        hook = lateCleanup
          ? (async () => {
              const context = captureOpenClawStateWorkerContext();
              await persistence.waitForPendingSubagentRegistryWrites(
                [original.runId],
                context.admission,
              );
              const previous = persistence.captureSubagentRunMutationSnapshot(original);
              original.cleanupCompletedAt = 3;
              await persistence.publishSubagentRunPostimages({
                runs: subagentRuns,
                previous: new Map([[original, previous]]),
                context,
                assertCurrent: () => context.admission.assertCurrent(),
                persist: (writeContext, callbacks, ...ids) =>
                  persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, {
                    context: writeContext,
                    ...callbacks,
                  }),
              });
            })()
          : cleanup.emitSubagentEndedHookForRun({ entry: original });
        void hook.catch(() => {});
        await Promise.race([
          producerWait.promise,
          hook.then(() => {
            throw new Error(
              "Predecessor writer settled before observing its pending-write snapshot",
            );
          }),
        ]);
      } else {
        await entered.promise;
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
      if (lateWrite) {
        await Promise.race([
          capturedWait.promise,
          followup.then(() => {
            throw new Error("Follow-up settled before observing its pending-write snapshot");
          }),
        ]);
        expect(capturedPending).toBe(true);
        releaseFirst.resolve();
        await firstWrite;
        if (!hook) {
          throw new Error("Predecessor writer did not enter before the follow-up");
        }
        await Promise.race([
          entered.promise,
          hook.then(() => {
            throw new Error("Predecessor writer settled before its held write");
          }),
        ]);
      }
      if (lateCleanup) {
        expect(original.cleanupCompletedAt).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().get(original.runId)?.cleanupCompletedAt).toBe(3);
        expect(original.endedHookEmittedAt).toBeUndefined();
        await Promise.race([additionalWait.promise, followup]);
      } else {
        await setImmediate();
      }
      expect.soft(settled).toBe(false);
      if (callerRetired) {
        callerCurrent = false;
      } else if (sourceReplaced) {
        const replacement = structuredClone(original);
        // The late case keeps stored fields equal to exercise the runtime-identity guard.
        if (!lateStamp) {
          replacement.generation = original.generation! + 1;
          replacement.task = "replacement owner";
          delete replacement.endedHookEmittedAt;
        }
        subagentRuns.set(original.runId, replacement);
        persistSubagentRunsToDiskOrThrow(subagentRuns, [replacement.runId]);
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
          sourceReplaced && !lateStamp ? "replacement owner" : "original work",
        );
        return;
      }
      expect(await followup).toEqual({ value: true });
      expect(loadSubagentRegistryFromSqlite().get("after-ended-hook")).toMatchObject({
        task: "follow-up work",
        generation: original.generation! + 1,
        execution: { status: "running" },
      });
      expect(loadSubagentRegistryFromSqlite().has(original.runId)).toBe(false);
    } finally {
      releaseFirst.resolve();
      entered.resolve();
      release.resolve();
      await Promise.allSettled([firstWrite, hook, followup]);
      restoreWaitObserver?.();
    }
  },
);
