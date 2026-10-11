// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** A cancellation result cannot publish a predecessor's task outcome after admitted reactivation. */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import type { AgentWaitResult } from "../../run-wait.js";
import type { KillPublicationPreparation } from "./subagent-control-kill-scope.js";
import * as killSession from "./subagent-control-session.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import type { SubagentAdminKillResult } from "./subagent-control.types.js";
import * as completionState from "./subagent-registry-completion.js";
import * as registryHelpers from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const rootKey = "agent:main:subagent:publication-root";
const childKey = "agent:main:subagent:publication-drain";

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

it("revalidates the session after held publication preparation permits retirement", async () => {
  const target = {
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: rootKey,
    defaultSessionId: "prepared-publication-session",
  };
  await writeSubagentSessionEntry(target);
  await registerSubagentRun({
    runId: "prepared-publication",
    childSessionKey: rootKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "publication ownership",
    cleanup: "keep",
  });
  const onResult = vi.fn();
  let transitioned = false;
  const publishSnapshot = vi.fn();
  const preparePublication = vi.fn<KillPublicationPreparation<SubagentAdminKillResult>["prepare"]>(
    async (publish) => {
      if (!transitioned) {
        transitioned = true;
        await removeSubagentSessionEntry(target);
      }
      return publish();
    },
  );
  const result = await killSubagentRunAdmin(
    {
      cfg: getRuntimeConfig(),
      sessionKey: rootKey,
      agentId: "main",
      expectedRunId: "prepared-publication",
      onResult,
    },
    {
      assertCurrent: () => {},
      preparePublication: { prepare: preparePublication, publishSnapshot },
    },
  );
  expect(publishSnapshot).toHaveBeenCalledExactlyOnceWith(result);
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
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: rootKey,
      defaultSessionId: "publication-root-session",
      lifecycleRevision: "publication-root-revision",
    });
    await registerSubagentRun({
      runId: "publication-b0",
      childSessionKey: rootKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "original task",
      cleanup: "keep",
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
        if (
          entry.runId === b0.runId &&
          entry.generation === b0.generation &&
          !completeDuringDrain &&
          !provisional
        ) {
          originalTimingEntered.resolve();
          await releaseOriginalTiming.promise;
        }
        if (priorChildKill && entry.runId === "publication-first") {
          // The tombstone is committed; let successor admission overtake real cleanup.
          firstChildCleanup.resolve();
          await releaseFirstChildCleanup.promise;
        }
        const completingOriginal =
          entry.runId === b0.runId &&
          entry.generation === b0.generation &&
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
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
      await registerSubagentRun({
        runId,
        childSessionKey: sessionKey,
        requesterSessionKey: rootKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
    }
    const entered = createDeferred();
    const childAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childKey, "publication-child-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const markerCleared = createDeferred();
    const releaseMarker = createDeferred();
    let markerWaits = 0;
    let followup: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    const handoffComplete = createDeferred();
    const resolveTargetState = completionState.resolveSubagentKillTargetState;
    let observedTarget = false;
    vi.spyOn(completionState, "resolveSubagentKillTargetState").mockImplementation((entry) => {
      const result = resolveTargetState(entry);
      if (
        handoff &&
        followup !== undefined &&
        entry.runId === b0.runId &&
        entry.generation === b0.generation &&
        !observedTarget
      ) {
        observedTarget = true;
        expect(subagentRuns.get(b0.runId)?.generation).toBe(b0.generation);
        handoffOrder.push("captured outcome");
        // Replace during the real awaited scope handoff, before synchronous publication.
        queueMicrotask(() => {
          if (!followup) {
            handoffComplete.reject(new Error("missing admitted follow-up"));
            return;
          }
          void followup
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
    const admin = vi.fn<typeof killSubagentRunAdmin>((params, control) =>
      killSubagentRunAdmin(
        {
          ...params,
          onResult: (result) => {
            params.onResult?.(result);
          },
        },
        control,
      ),
    );
    const originalEndedAt = Date.now();
    // The earlier producer result arrives only after cancellation enters descendant drain.
    const cancellationClock = completeDuringDrain
      ? vi.spyOn(Date, "now").mockReturnValue(originalEndedAt + 1)
      : undefined;
    const pending = admin({
      cfg: getRuntimeConfig(),
      sessionKey: rootKey,
      expectedRunId: b0.runId,
      expectedGeneration: b0.generation,
      expectedOwnerKey: b0.requesterSessionKey,
    });
    const followupInterrupted = vi.fn();
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Cancellation never entered descendant drain: ${JSON.stringify(result)}`);
        }),
      ]);
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

        await Promise.race([
          markerCleared.promise,
          pending.then((result) => {
            throw new Error(`Cancellation never reached marker cleanup: ${JSON.stringify(result)}`);
          }),
        ]);
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry.abortedLastRun,
        ).toBe(false);
      }
      if (priorChildKill) {
        await firstChildCleanup.promise;
        expect(resolveSubagentSessionStatus(subagentRuns.get("publication-first"))).toBe("killed");
      }

      // The root lifecycle lock and any marker write have finished before follow-up admission.
      followup = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [rootKey, "publication-root-session"],
        assertAllowed: () => {},
        onInterrupt: followupInterrupted,
      });
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
      await pending;
      if (handoff) {
        expect(observedTarget, "admin resolved its root outcome").toBe(true);
        expect(handoffOrder, "admin captured its owner outcome").not.toEqual([]);
        await handoffComplete.promise;
        expect(handoffOrder.slice(0, 2)).toEqual(["captured outcome", "replacement"]);
      }
      const published = await admin.mock.results[0]!.value;
      expect(markerWaits).toBe(completeDuringDrain ? 1 : 0);
      if (!handoff) {
        expect.soft(published).not.toHaveProperty("targetState");
        expect.soft(published).toHaveProperty("error", expect.any(String));
      }
      expect.soft(handoffOrder).not.toContain("task write");
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
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
