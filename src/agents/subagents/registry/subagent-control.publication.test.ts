// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { registerPluginSubagentRunFromGateway } from "../../../gateway/server-methods/agent-subagent-registration.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as gatewayLifecycle from "../../../gateway/server-recovery-runtime-context.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import type { AgentWaitResult } from "../../run-wait.js";
import * as killScopeOwner from "./subagent-control-kill-scope.js";
import * as killSession from "./subagent-control-session.js";
import {
  beginControlAdmission,
  createControlRunFixture,
  expectControlIdle,
} from "./subagent-control.fixtures.test-support.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import * as completionState from "./subagent-registry-completion.js";
import * as registryHelpers from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  persistRegistryFixture,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
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
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const runs = createControlRunFixture(() => fixture.stateDir);
const rootKey = "agent:main:subagent:publication-root";
const childKey = "agent:main:subagent:publication-drain";

it.each(["live", "revoked", "replaced child", "replaced Gateway"] as const)(
  "settles an unstarted plugin registration with a %s owner",
  async (ownerState) => {
    const childSessionKey = "agent:main:subagent:unstarted-plugin";
    const runId = "unstarted-plugin";
    const target = {
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "unstarted-plugin-session",
      lifecycleRevision: "unstarted-plugin-revision",
    };
    const storePath = await writeSubagentSessionEntry(target);
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: "agent:main:main",
      defaultSessionId: "unstarted-plugin-requester-session",
    });
    const sessionEntry = expectDefined(
      loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey }),
      "child session",
    ).entry;
    const context = createContext();
    let currentGateway = context;
    context.getRuntimeConfig = getRuntimeConfig;
    context.resolveGatewayContext = () => currentGateway;
    const client = createOperatorClient({
      profileName: "unstarted-plugin-requester",
      scopes: ["operator.write"],
    });
    const revoked = new AbortController();
    const source = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      }),
      "operator source",
    );
    client.internal = { operatorRunAuthority: source.authority };
    vi.spyOn(gatewayLifecycle, "bindGatewayLifecycleRequest").mockReturnValue(callGateway);
    const announcementEntered = createDeferred();
    const continueAnnouncement = createDeferred();
    let announcement:
      | { source?: unknown; scopes?: readonly string[]; prepared?: boolean; allowed?: boolean }
      | undefined;
    fixture.announce.mockImplementation(async (params) => {
      const retained =
        getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
      announcement = { source: retained?.source, scopes: retained?.scopes };
      retained?.assertCurrent();
      if (ownerState === "replaced Gateway") {
        announcementEntered.resolve();
        await continueAnnouncement.promise;
        announcement.prepared = await params.prepareChildSessionEffects?.();
        announcement.allowed = params.isChildSessionEffectsAllowed?.();
        return "intentional_non_delivery";
      }
      if (ownerState === "replaced child") {
        announcement.prepared = await params.prepareChildSessionEffects?.();
        announcement.allowed = params.isChildSessionEffectsAllowed?.();
      }
      return "delivered";
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
      const beforeCleanup = loadExactSessionEntryReadOnly({
        storePath,
        sessionKey: childSessionKey,
      });
      await expectDefined(rejectAdmission, "committed rejection cleanup")("admission rejected");
      if (ownerState === "replaced Gateway") {
        await announcementEntered.promise;
        currentGateway = createContext();
        continueAnnouncement.resolve();
      }
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        requesterSessionKey: "agent:main:main",
        execution: {
          status: "terminal",
          outcome: { status: "error", error: "admission rejected" },
        },
        completion: { resultText: "admission rejected" },
      });
      if (ownerState !== "revoked") {
        expect(fixture.announce).toHaveBeenCalledOnce();
        expect(announcement).toMatchObject({
          source: source.authority.source,
          scopes: ["operator.write"],
        });
        if (ownerState === "replaced Gateway" || ownerState === "replaced child") {
          expect(announcement).toMatchObject({ prepared: false, allowed: false });
        }
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
        expect(loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey })).toEqual(
          beforeCleanup,
        );
      } else {
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey })?.entry,
        ).toMatchObject({
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
    const childSessionKey = "agent:main:subagent:rejected-publication";
    const runId = "rejected-publication";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "rejected-publication-session",
    });
    const sessionBefore = expectDefined(
      loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey }),
      "child session",
    ).entry;
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
      runId,
      taskRunId: mode === "adoption" ? "paused-publication" : runId,
      execution: { status: "terminal", outcome: { status: "error", error: "admission rejected" } },
      completion: { resultText: "admission rejected" },
    });
    expect(
      loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey })?.entry,
    ).toEqual(sessionBefore);
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
  const read = () => loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry;
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
  [false, false, false, false],
  [true, false, false, false],
  [false, true, false, false],
  [true, false, true, false],
  [true, false, true, true],
])(
  "fences replacement cancellation publication (priorChildKill=%s, completeDuringDrain=%s, handoff=%s, provisional=%s)",
  async (priorChildKill, completeDuringDrain, handoff, provisional) => {
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
    expect(b0.collect).not.toBe(true);

    const successorCompleted = createDeferred();
    const originalCompleted = createDeferred();
    const originalTimingCompleted = createDeferred();
    const originalSettled = createDeferred();
    const stopObserving = subscribeSubagentRunChanges("persistence", () => {
      const original = subagentRuns.get(b0.runId);
      if (original?.execution.outcome) {
        originalSettled.resolve();
      }
      if (original?.execution.outcome?.status === "ok") {
        originalCompleted.resolve();
      }
      if (subagentRuns.get("publication-b1")?.execution.outcome?.status === "ok") {
        successorCompleted.resolve();
      }
    });
    const handoffOrder: string[] = [];
    const originalTimingEntered = createDeferred();
    const releaseOriginalTiming = createDeferred();
    const firstChildCleanup = createDeferred();
    const releaseFirstChildCleanup = createDeferred();
    const persistTiming = registryHelpers.persistSubagentSessionTiming;
    vi.spyOn(registryHelpers, "persistSubagentSessionTiming").mockImplementation(
      async (entry, options) => {
        const original = entry.runId === b0.runId && entry.generation === b0.generation;
        if (original && !completeDuringDrain && !provisional) {
          originalTimingEntered.resolve();
          await releaseOriginalTiming.promise;
        }
        if (priorChildKill && entry.runId === "publication-first") {
          // The tombstone is committed; let successor admission overtake real cleanup.
          firstChildCleanup.resolve();
          await releaseFirstChildCleanup.promise;
        }
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
      const firstBoundary = Promise.race([
        originalSettled.promise.then(() => "terminal-publication"),
        originalTimingEntered.promise.then(() => "session-cleanup"),
      ]);
      try {
        previousWait.resolve({
          status: "error",
          error: "original run failed",
          endedAt: Date.now(),
        });
        await originalTimingEntered.promise;
        expect(subagentRuns.get(b0.runId)?.execution.status).toBe("terminal");
        expect(subagentRuns.get(b0.runId)?.execution.outcome?.status).toBe("error");
        expect(
          await firstBoundary,
          "terminal publication must not wait for post-commit session cleanup",
        ).toBe("terminal-publication");
      } finally {
        releaseOriginalTiming.resolve();
      }
      await fixture.settle();
    }

    const children: Array<readonly [string, string]> = [
      ...(priorChildKill
        ? [["publication-first", "agent:main:subagent:publication-first"] as const]
        : []),
      ["publication-child", childKey],
    ];
    for (const [runId, sessionKey] of children) {
      await runs.seed(runId, {
        childSessionKey: sessionKey,
        requesterSessionKey: rootKey,
        requesterTurnRunId: b0.runId,
        collect: true,
        queued: true,
      });
    }
    const entered = createDeferred();
    const childAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [childKey, "publication-child-session"],
      run: {
        runId: "publication-child",
        sessionKey: childKey,
        sessionId: "publication-child-session",
        agentId: "main",
      },
      assertAllowed: () => {},
      onInterrupt: () => {
        entered.resolve();
        return { runId: "publication-child" };
      },
    });
    const markerCleared = createDeferred();
    const releaseMarker = createDeferred();
    let markerWaits = 0;
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
        expect(subagentRuns.get(b0.runId)?.generation).toBe(b0.generation);
        handoffOrder.push("captured outcome");
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
              handoffOrder.push("replacement");
              expect(subagentRuns.get("publication-b1")?.generation).not.toBe(b0.generation);
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
        markerWaits += 1;
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
        await originalCompleted.promise;
        // Completion timing clears the abort marker after its registry outcome is durable.
        await originalTimingCompleted.promise;
        expect(subagentRuns.get(b0.runId)?.killReconciliation).toBeUndefined();
        childAdmission.release();

        await awaitGateBeforeSettlement(
          markerCleared.promise,
          pending,
          "Cancellation never reached marker cleanup",
        );
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry.abortedLastRun,
        ).toBe(false);
      }
      if (priorChildKill) {
        await firstChildCleanup.promise;
        expect(resolveSubagentSessionStatus(subagentRuns.get("publication-first"))).toBe("killed");
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
        const b1 = subagentRuns.get("publication-b1")!;
        expect(subagentRuns.get(b0.runId)).toMatchObject({
          taskRunId: b0.taskRunId,
          execution: { status: "terminal", suppressSessionEffects: true },
        });
        expect(b1).toMatchObject({ taskRunId: b1.runId, execution: { status: "running" } });
        if (typeof b0.generation !== "number") {
          throw new Error("Registration did not mint a run generation");
        }
        expect(b1.generation).toBeGreaterThan(b0.generation);
      }

      childAdmission.release();
      releaseMarker.resolve();
      releaseFirstChildCleanup.resolve();
      const published = await pending;
      if (handoff) {
        expect(observedTarget, "admin resolved its root outcome").toBe(true);
        await handoffComplete.promise;
        expect(handoffOrder.slice(0, 2)).toEqual(["captured outcome", "replacement"]);
      }
      expect(markerWaits).toBe(completeDuringDrain ? 1 : 0);
      if (!handoff) {
        expect.soft(published).not.toHaveProperty("targetState");
        expect.soft(published).toHaveProperty("error", expect.any(String));
      }
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("running");
      expect(followupInterrupted).not.toHaveBeenCalled();
      expect(published).toMatchObject({
        found: true,
        killed: priorChildKill || completeDuringDrain || handoff,
        cascadeKilled: Number(priorChildKill) + Number(completeDuringDrain || handoff),
      });
      nextWait.resolve({
        status: "ok",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "follow-up completed" },
      });
      await successorCompleted.promise;
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("terminal");
      if (priorChildKill && !handoff) {
        // Successor admission retires the first child's delayed cleanup authority.
        await expect(fixture.settle()).rejects.toMatchObject({
          message: "Failed to settle subagent cleanup roots",
          errors: [
            expect.objectContaining({
              message: "Subagent kill publication lost its original claim",
            }),
          ],
        });
      }
    } finally {
      stopObserving();
      cancellationClock?.mockRestore();
      releaseMarker.resolve();
      releaseFirstChildCleanup.resolve();
      childAdmission.release();
      followup?.release();
      await pending;
      expectControlIdle();
    }
  },
);
