// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import * as gatewayLifecycle from "../../../gateway/server-lifecycle-runtime-context.js";
import { registerPluginSubagentRunFromGateway } from "../../../gateway/server-methods/agent-subagent-registration.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { isSwarmRunActive } from "../swarm/swarm-scheduler.js";
import * as killScopeOwner from "./subagent-control-kill-scope.js";
import * as killSession from "./subagent-control-session.js";
import {
  beginControlAdmission,
  controlController,
  controlMetadataProducer,
  createControlRunFixture,
  enqueueControlRun,
  expectControlIdle,
  holdControlSessionPublication,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import * as completionState from "./subagent-registry-completion.js";
import * as registryHelpers from "./subagent-registry-helpers.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  persistRegistryFixture,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { retainedOperatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import {
  adoptPausedSubagentRunForFollowUp,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import type { SubagentAdmissionRejection } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture();
const runs = createControlRunFixture(() => fixture.stateDir);
const rootKey = "agent:main:subagent:publication-root";
const drainChildKey = "agent:main:subagent:publication-drain";
const readSession = (storePath: string, sessionKey = rootKey) =>
  loadExactSessionEntryReadOnly({ storePath, sessionKey });
const rejectedRun = {
  execution: { status: "terminal", outcome: { status: "error", error: "admission rejected" } },
  completion: { resultText: "admission rejected" },
};

async function writeRegistrationSession(runId: string, lifecycleRevision?: string) {
  const target = {
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: `agent:main:subagent:${runId}`,
    defaultSessionId: `${runId}-session`,
    lifecycleRevision,
  };
  const storePath = await writeSubagentSessionEntry(target);
  const sessionEntry = expectDefined(
    readSession(storePath, target.sessionKey),
    "child session",
  ).entry;
  return { target, storePath, sessionEntry, childSessionKey: target.sessionKey };
}

it.each(["live", "revoked", "replaced child", "replaced Gateway"] as const)(
  "settles an unstarted plugin registration with a %s owner",
  async (ownerState) => {
    const runId = "unstarted-plugin";
    const { target, storePath, sessionEntry, childSessionKey } = await writeRegistrationSession(
      runId,
      "unstarted-plugin-revision",
    );
    await runs.writeSession("unstarted-plugin-requester", undefined, {
      sessionKey: "agent:main:main",
    });
    const context = createContext();
    let currentGateway = context;
    context.getRuntimeConfig = getRuntimeConfig;
    const { client, revoked, source } = await retainedOperatorFixture(
      "unstarted-plugin-requester",
      context,
      () => currentGateway,
    );
    vi.spyOn(gatewayLifecycle, "bindGatewayLifecycleRequest").mockReturnValue(callGateway);
    const announcementEntered = createDeferred();
    const continueAnnouncement = createDeferred();
    fixture.announce.mockImplementation(async (params) => {
      const retained =
        getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
      expect(retained).toMatchObject({
        source: source.authority.source,
        scopes: ["operator.write"],
      });
      retained?.assertCurrent();
      if (ownerState === "replaced Gateway") {
        announcementEntered.resolve();
        await continueAnnouncement.promise;
      }
      if (ownerState === "replaced child" || ownerState === "replaced Gateway") {
        expect([
          await params.prepareChildSessionEffects?.(),
          params.isChildSessionEffectsAllowed?.(),
        ]).toEqual([false, false]);
      }
      return ownerState === "replaced Gateway" ? "intentional_non_delivery" : "delivered";
    });
    let rejectAdmission: SubagentAdmissionRejection | undefined;
    try {
      await withPluginRuntimeGatewayRequestScope(
        {
          client,
          context,
          resolveGatewayContext: context.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        () =>
          registerPluginSubagentRunFromGateway({
            cfg: getRuntimeConfig(),
            runId,
            childSessionKey,
            childAgentId: "main",
            agentDir: path.join(fixture.stateDir, "agents", "main", "agent"),
            workspaceDir: path.join(fixture.stateDir, "workspace"),
            task: "unstarted operation",
            requester: {
              sessionKey: "agent:main:main",
              origin: { channel: "webchat", to: "requester" },
            },
            gatewayContextResolver: context.resolveGatewayContext,
            assertCurrent: () => {
              source.authority.assertCurrent();
              return sessionEntry;
            },
            admittedSession: {
              sessionId: target.defaultSessionId,
              storePath,
              entry: sessionEntry,
            },
            retainAdmission: (reject) => {
              rejectAdmission = reject;
            },
          }),
      );
      source.release();
      if (ownerState === "revoked") {
        revoked.abort(new Error("requester access revoked"));
      } else if (ownerState === "replaced child") {
        await writeSubagentSessionEntry({
          ...target,
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-revision",
        });
      }
      const beforeCleanup = readSession(storePath, childSessionKey);
      await expectDefined(rejectAdmission, "committed rejection cleanup")("admission rejected");
      if (ownerState === "replaced Gateway") {
        await announcementEntered.promise;
        currentGateway = createContext();
        continueAnnouncement.resolve();
      }
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        ...rejectedRun,
        requesterSessionKey: "agent:main:main",
      });
      if (ownerState !== "revoked") {
        expect(fixture.announce).toHaveBeenCalledOnce();
        if (ownerState !== "replaced Gateway") {
          expect(loadSubagentRegistryFromSqlite().get(runId)?.delivery?.status).toBe("delivered");
        }
      } else {
        expect(fixture.announce).not.toHaveBeenCalled();
        const entry = expectDefined(subagentRuns.get(runId), "failed registration");
        expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
          /authority/,
        );
      }
      if (ownerState === "replaced child") {
        expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).toBe(
          true,
        );
        expect(readSession(storePath, childSessionKey)).toEqual(beforeCleanup);
      } else {
        expect(readSession(storePath, childSessionKey)?.entry).toMatchObject({
          sessionId: target.defaultSessionId,
          status: "failed",
          lastRunError: expect.anything(),
        });
      }
    } finally {
      continueAnnouncement.resolve();
      source.release();
    }
  },
);

it.each(["registration", "adoption"] as const)(
  "retains committed %s cleanup when publication throws",
  async (mode) => {
    const runId = "rejected-publication";
    const {
      storePath,
      childSessionKey,
      sessionEntry: sessionBefore,
    } = await writeRegistrationSession(runId);
    const registration = {
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: sessionBefore,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "unstarted operation",
      cleanup: "keep" as const,
      expectsCompletionMessage: false,
    };
    if (mode === "adoption") {
      await registerSubagentRun({ ...registration, runId: "paused-publication" });
      const paused = structuredClone(
        expectDefined(subagentRuns.get("paused-publication"), "paused run"),
      );
      paused.pauseReason = "sessions_yield";
      paused.execution = { ...paused.execution, status: "terminal", endedAt: Date.now() };
      subagentRuns.set(paused.runId, paused);
      persistRegistryFixture(subagentRuns, [paused.runId]);
    }
    let rejectAdmission: SubagentAdmissionRejection | undefined;
    const retainAdmission = (reject: SubagentAdmissionRejection) => {
      rejectAdmission = reject;
    };
    const unsubscribe = subscribeSubagentRunChanges("projection", ({ runIds }) => {
      if (runIds?.includes(runId)) {
        throw new Error("publication failed after commit");
      }
    });
    try {
      await expect(async () => {
        if (mode === "adoption") {
          await adoptPausedSubagentRunForFollowUp({
            childSessionKey,
            childAgentId: "main",
            runId,
            task: registration.task,
            retainAdmission,
          });
        } else {
          await registerSubagentRun(registration, { retainAdmission });
        }
      }).rejects.toThrow("publication failed after commit");
    } finally {
      unsubscribe();
    }
    const committed = expectDefined(subagentRuns.get(runId), "committed registration");
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      runId,
      generation: committed.generation,
      execution: { status: "running" },
    });
    expect(subagentRuns.has("paused-publication")).toBe(false);
    await expectDefined(rejectAdmission, "committed rejection cleanup")("admission rejected");
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      ...rejectedRun,
      runId,
      taskRunId: mode === "adoption" ? "paused-publication" : runId,
    });
    expect(readSession(storePath, childSessionKey)?.entry).toEqual(sessionBefore);
  },
);

it("does not refresh session metadata when an owned abort marker is already persisted", async () => {
  const sessionId = "idempotent-abort-session";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: rootKey,
    defaultSessionId: sessionId,
    abortedLastRun: true,
    updatedAt: 17,
  });
  const read = () => readSession(storePath)?.entry;
  const before = read();
  expect(before?.abortedLastRun).toBe(true);
  const marker = {
    childSessionKey: rootKey,
    session: { storePath, entry: before },
    abortedLastRun: true,
  };
  expect(await killSession.persistSubagentAbortedLastRun(marker)).toBe(true);
  expect(read()).toEqual(before);

  const assertCommitAllowed = vi.fn(() => {
    throw new Error("Abort-marker authority was revoked");
  });
  expect(await killSession.persistSubagentAbortedLastRun({ ...marker, assertCommitAllowed })).toBe(
    false,
  );
  expect(assertCommitAllowed).toHaveBeenCalled();
  expect(read()).toEqual(before);
});

it("revalidates the original session after deletion during cancellation result handoff", async () => {
  const { target } = await runs.seed("prepared-publication", {
    childSessionKey: rootKey,
    expectsCompletionMessage: undefined,
  });
  const withKillScope = killScopeOwner.withSubagentKillScope;
  using _ = vi
    .spyOn(killScopeOwner, "withSubagentKillScope")
    .mockImplementation((params, run, ...publicationCallbacks) =>
      withKillScope(
        params,
        async (scope, trees) => {
          const result = await run(scope, trees);
          await removeSubagentSessionEntry(target);
          return result;
        },
        ...publicationCallbacks,
      ),
    );
  const onResult = vi.fn();
  const onSnapshot = vi.fn();
  const result = await killSubagentRunAdmin(
    {
      cfg: getRuntimeConfig(),
      sessionKey: rootKey,
      agentId: "main",
      expectedRunId: "prepared-publication",
      onResult,
    },
    { assertCurrent: () => {}, onSnapshot },
  );
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(result);
  expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
  expect(result).toMatchObject({
    found: true,
    error: expect.stringContaining("ownership changed"),
  });
  expect(result).not.toHaveProperty("targetState");
});

it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, true, true],
])(
  "fences replacement cancellation publication (completeDuringDrain=%s, handoff=%s, provisional=%s)",
  async (completeDuringDrain, handoff, provisional) => {
    fixture.announce.mockResolvedValue("delivered");
    const previousWait = createDeferred<AgentWaitResult>();
    const nextWait = createDeferred<AgentWaitResult>();
    fixture.gateway.mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      const runId = (request.params as { runId: string }).runId;
      expect(["publication-b0", "publication-b1"]).toContain(runId);
      return await (runId === "publication-b0" ? previousWait : nextWait).promise;
    });
    const { storePath } = await runs.seed("publication-root", {
      childSessionKey: rootKey,
      runId: "publication-b0",
      expectsCompletionMessage: true,
    });
    const b0 = subagentRuns.get("publication-b0")!;

    const successorCompleted = createDeferred();
    const originalTimingCompleted = createDeferred();
    const stopObserving = subscribeSubagentRunChanges("persistence", () => {
      if (subagentRuns.get("publication-b1")?.execution.outcome?.status === "ok") {
        successorCompleted.resolve();
      }
    });
    const persistTiming = registryHelpers.persistSubagentSessionTiming;
    vi.spyOn(registryHelpers, "persistSubagentSessionTiming").mockImplementation(
      async (entry, options) => {
        const original = entry.runId === b0.runId && entry.generation === b0.generation;
        const completingOriginal =
          original &&
          entry.execution.status === "terminal" &&
          entry.execution.outcome?.status === "ok";
        await persistTiming(entry, options);
        if (completingOriginal) {
          originalTimingCompleted.resolve();
        }
      },
    );
    if (!completeDuringDrain && !provisional) {
      previousWait.resolve({ status: "error", error: "original run failed", endedAt: Date.now() });
      await fixture.settle();
    }

    await runs.seed("publication-child", {
      childSessionKey: drainChildKey,
      requesterSessionKey: rootKey,
      requesterTurnRunId: b0.runId,
      collect: true,
      queued: true,
    });
    const entered = createDeferred();
    const childAdmission = await beginControlAdmission(
      storePath,
      drainChildKey,
      "publication-child-session",
      () => {
        entered.resolve();
        return { runId: "publication-child" };
      },
      "publication-child",
    );
    const markerCleared = createDeferred();
    const releaseMarker = createDeferred();
    let followup: Awaited<ReturnType<typeof beginControlAdmission>> | undefined;
    const handoffComplete = createDeferred();
    const resolveTargetState = completionState.resolveSubagentKillTargetState;
    let observedTarget = false;
    vi.spyOn(completionState, "resolveSubagentKillTargetState").mockImplementation((entry) => {
      const result = resolveTargetState(entry);
      const admission = followup;
      if (
        handoff &&
        admission !== undefined &&
        entry.runId === b0.runId &&
        entry.generation === b0.generation &&
        !observedTarget
      ) {
        observedTarget = true;
        // Replace during the real awaited scope handoff, before synchronous publication.
        queueMicrotask(() => {
          void admission
            .run(async () => {
              // Follow-up admission authorizes the same asynchronous row owner as reactivation.
              expect(
                await replaceSubagentRunAfterSteerCore({
                  previousRunId: b0.runId,
                  nextRunId: "publication-b1",
                  runTimeoutSeconds: b0.runTimeoutSeconds ?? 0,
                  task: "admitted follow-up task",
                }),
              ).toBe(true);
            })
            .then(handoffComplete.resolve, handoffComplete.reject);
        });
      }
      return result;
    });
    const persistMarker = killSession.persistSubagentAbortedLastRun;
    vi.spyOn(killSession, "persistSubagentAbortedLastRun").mockImplementation(async (params) => {
      const result = await persistMarker(params);
      if (completeDuringDrain && params.childSessionKey === rootKey && !params.abortedLastRun) {
        markerCleared.resolve();
        await releaseMarker.promise;
      }
      return result;
    });
    const originalEndedAt = Date.now();
    // The earlier producer result arrives only after cancellation enters descendant drain.
    const cancellationClock = completeDuringDrain
      ? vi.spyOn(Date, "now").mockReturnValue(originalEndedAt + 1)
      : undefined;
    const pending = killSubagentRunAdmin({
      cfg: getRuntimeConfig(),
      sessionKey: rootKey,
      expectedRunId: b0.runId,
      expectedGeneration: b0.generation,
      expectedOwnerKey: b0.requesterSessionKey,
    });
    const followupInterrupted = vi.fn();
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Cancellation never entered descendant drain",
      );
      if (completeDuringDrain) {
        previousWait.resolve({
          status: "ok",
          endedAt: originalEndedAt,
          terminalReply: { disposition: "visible", text: "original completed during cancellation" },
        });
        // Completion timing clears the abort marker after its registry outcome is durable.
        await originalTimingCompleted.promise;
        expect(subagentRuns.get(b0.runId)?.killReconciliation).toBeUndefined();
        childAdmission.release();

        await awaitGateBeforeSettlement(
          markerCleared.promise,
          pending,
          "Cancellation never reached marker cleanup",
        );
        expect(readSession(storePath)?.entry.abortedLastRun).toBe(false);
      }
      // The root lifecycle lock and any marker write have finished before follow-up admission.
      followup = await beginControlAdmission(
        storePath,
        rootKey,
        "publication-root-session",
        followupInterrupted,
      );
      if (!handoff) {
        expect(
          await followup.run(() =>
            reactivateCompletedSubagentSession({
              sessionKey: rootKey,
              runId: "publication-b1",
              task: "admitted follow-up task",
            }),
          ),
        ).toBe(true);
        expect(subagentRuns.get(b0.runId)).toMatchObject({
          execution: { status: "terminal", suppressSessionEffects: true },
        });
      }

      childAdmission.release();
      releaseMarker.resolve();
      const published = await pending;
      if (handoff) {
        expect(observedTarget, "admin resolved its root outcome").toBe(true);
        await handoffComplete.promise;
      }
      if (!handoff) {
        expect.soft(published).not.toHaveProperty("targetState");
        expect.soft(published).toHaveProperty("error", expect.any(String));
      }
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("running");
      expect(followupInterrupted).not.toHaveBeenCalled();
      expect(published).toMatchObject({
        found: true,
        killed: completeDuringDrain || handoff,
        cascadeKilled: Number(completeDuringDrain || handoff),
      });
      nextWait.resolve({
        status: "ok",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "follow-up completed" },
      });
      await successorCompleted.promise;
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("terminal");
    } finally {
      stopObserving();
      cancellationClock?.mockRestore();
      releaseMarker.resolve();
      childAdmission.release();
      followup?.release();
      await pending;
      expectControlIdle();
    }
  },
);

describe("metadata publication", () => {
  const { controllerSessionKey: parentKey } = controlController;
  const killedRun = { endedReason: "subagent-killed", execution: { status: "terminal" } };

  beforeEach(() => captureRuntimeConfigAsyncReader()());

  it.for([
    { replacement: true, publication: "tombstone" },
    { replacement: false, publication: "tombstone" },
    { replacement: false, publication: "result" },
    { replacement: true, publication: "result" },
  ])(
    "joins a pending session publication before cancellation $publication (replacement=$replacement)",
    async ({ replacement, publication }, { signal }) => {
      const runId = "pending-kill-publication";
      const child = await runs.seed(runId, { requesterDisplayKey: parentKey });
      const { sessionKey: childKey, sessionId, storePath } = child;
      const killScope = new AsyncLocalStorage<boolean>();
      const held = holdControlSessionPublication({
        signal,
        consumerScope: killScope,
      });
      const { state, release, dispose } = held;
      const producer = controlMetadataProducer(held, child, signal, { replacement });
      const acquire = vi.spyOn(
        SubagentLifecycleController.prototype,
        "acquireTerminalCompletionLock",
      );
      acquire.mockRestore();
      vi.spyOn(
        SubagentLifecycleController.prototype,
        "acquireTerminalCompletionLock",
      ).mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
        const unlock = await acquire.call(this, targetRunId);
        if (publication === "tombstone" && targetRunId === runId) {
          await producer.start();
        }
        return unlock;
      });
      const withKillScope = killScopeOwner.withSubagentKillScope;
      vi.spyOn(killScopeOwner, "withSubagentKillScope").mockImplementation(
        (params, run, ...publicationCallbacks) =>
          withKillScope(
            params,
            async (scope, trees) => {
              const result = await run(scope, trees);
              if (publication === "result") {
                expect(subagentRuns.get(runId)).toMatchObject(killedRun);
                await producer.start();
              }
              return result;
            },
            ...publicationCallbacks,
          ),
      );
      const onResult = vi.fn();
      const onSnapshot = vi.fn();
      try {
        const result = await killScope
          .run(true, () =>
            publication === "result"
              ? killSubagentRunAdmin(
                  {
                    cfg: getRuntimeConfig(),
                    sessionKey: childKey,
                    agentId: "main",
                    expectedRunId: runId,
                    onResult,
                  },
                  { assertCurrent: () => {}, onSnapshot },
                )
              : killAllControlledSubagentRuns({
                  cfg: getRuntimeConfig(),
                  controller: controlController,
                  runs: [subagentRuns.get(runId)!],
                }),
          )
          .finally(release);
        if (!replacement && publication !== "result") {
          expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", killed: 1 });
        }
        expect(state).toEqual({ holdingResult: true, joinedPublication: true });
        expect(await producer.outcome).toEqual({ ok: true });
        const persisted = loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry;
        expect(persisted).toMatchObject({
          sessionId: replacement ? `${sessionId}-replacement` : sessionId,
          label: "metadata survived",
        });
        if (publication === "result") {
          expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(result);
          expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
          expect(result).toMatchObject({ found: true, killed: true });
          if (replacement) {
            expect(result).toHaveProperty("error", expect.stringContaining("ownership changed"));
            expect(result).not.toHaveProperty("targetState");
          } else {
            expect(result).not.toHaveProperty("error");
            expect(result).toMatchObject({
              targetState: { state: "terminal", task: { status: "cancelled" } },
            });
          }
          return;
        }
        if (replacement) {
          expect(result, JSON.stringify(result)).toMatchObject({ status: "error", killed: 0 });
          expect(persisted?.abortedLastRun).not.toBe(true);
          expect(subagentRuns.get(runId)?.endedReason).not.toBe("subagent-killed");
        } else {
          expect(persisted?.abortedLastRun).toBe(true);
          expect(subagentRuns.get(runId)).toMatchObject(killedRun);
        }
      } finally {
        release();
        await producer.outcome;
        dispose();
      }
    },
  );

  it("joins a pending session publication before a collector terminal commit", async ({
    signal,
  }) => {
    const runId = "pending-collector-publication";
    const child = await runs.seed(runId, {
      requesterDisplayKey: parentKey,
      collect: true,
      queued: false,
    });
    const { sessionKey: childKey, sessionId, storePath } = child;
    enqueueControlRun(runId, "pending-collector-sibling", [runId], async () => {});
    const completionScope = new AsyncLocalStorage<boolean>();
    let statusWhileJoined: string | undefined;
    const held = holdControlSessionPublication({
      signal,
      consumerScope: completionScope,
      afterReleased: () => {
        // The waiting commit keeps its staged terminal row off-registry.
        statusWhileJoined = subagentRuns.get(runId)?.execution.status;
      },
    });
    const { state, release, dispose } = held;
    const producer = controlMetadataProducer(held, child, signal);
    const prepareSession = killSession.prepareSubagentKillSession.bind(killSession);
    vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
      const session = await prepareSession(...args);
      if (!completionScope.getStore() || args[1] !== childKey || producer.outcome) {
        return session;
      }
      // Completion retained generation facts; a child metadata writer now reaches its
      // native commit before the terminal registry commit.
      await producer.start();
      return {
        ...session,
        // A failed commit still releases its session; never strand the held producer.
        release: async () => {
          release();
          await session.release();
        },
      };
    });
    const startedStatus = subagentRuns.get(runId)?.execution.status;
    try {
      completionScope.run(true, () =>
        emitAgentEvent({
          runId,
          sessionKey: childKey,
          sessionId,
          stream: "lifecycle",
          data: { phase: "end" },
        }),
      );
      await fixture.settle();
      expect(state).toEqual({ holdingResult: true, joinedPublication: true });
      expect(startedStatus).not.toBe("terminal");
      expect(statusWhileJoined).toBe(startedStatus);
      expect(await producer.outcome).toEqual({ ok: true });
      expect(subagentRuns.get(runId)).toMatchObject({ execution: { status: "terminal" } });
      expect(isSwarmRunActive(runId)).toBe(false);
      expect(
        loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry,
      ).toMatchObject({ sessionId, label: "metadata survived" });
    } finally {
      release();
      await producer.outcome;
      dispose();
    }
  });
});
