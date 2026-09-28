// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { persistSubagentRunsToDiskOrThrow, useSubagentControlFixture } from "./subagent-control.test-support.js";
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
import * as killRuntime from "./subagent-control-kill-runtime.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const rootKey = "agent:main:subagent:publication-root";
const childKey = "agent:main:subagent:publication-drain";

it.each(["replacement", "retirement"] as const)(
  "revalidates the session after held publication preparation permits %s",
  async (transition) => {
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
    const preparePublication = vi.fn(async () => {
      if (transition === "replacement") {
        await writeSubagentSessionEntry({ ...target, sessionId: "successor-session" });
      } else {
        await removeSubagentSessionEntry(target);
      }
    });
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
        preparePublication: { prepare: preparePublication, needsPreparation: () => false },
      },
    );
    expect(preparePublication).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
    expect(result).toMatchObject({
      found: true,
      error: expect.stringContaining("ownership changed"),
    });
    expect(result).not.toHaveProperty("targetState");
  },
);

it.each([
  [true, false, false, false, false],
  [true, true, false, false, false],
  [false, false, false, false, false],
  [false, false, true, false, false],
  [true, false, true, false, false],
  [true, false, false, true, false],
  [true, true, false, true, false],
  [true, true, false, true, true],
])(
  "fences native cancellation publication (replace=%s, priorChildKill=%s, completeDuringDrain=%s, handoff=%s, provisional=%s)",
  async (replace, priorChildKill, completeDuringDrain, handoff, provisional) => {
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
    const originalSettled = createDeferred();
    fixture.persist.mockImplementation((...runIds) => {
      persistSubagentRunsToDiskOrThrow(...runIds);
      if (b0.execution.outcome) {
        originalSettled.resolve();
      }
      if (b0.execution.outcome?.status === "ok") {
        originalCompleted.resolve();
      }
      if (subagentRuns.get("publication-b1")?.execution.outcome?.status === "ok") {
        successorCompleted.resolve();
      }
    });
    const handoffOrder: string[] = [];
    if (!completeDuringDrain && !provisional) {
      previousWait.resolve({ status: "error", error: "original run failed", endedAt: Date.now() });
      await originalSettled.promise;
      expect(b0.execution.status).toBe("terminal");
      expect(b0.execution.outcome?.status).toBe("error");
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
    const resolveTargetState = killRuntime.resolveSubagentKillTargetState;
    let observedTarget = false;
    vi.spyOn(killRuntime, "resolveSubagentKillTargetState").mockImplementation((entry) => {
      const result = resolveTargetState(entry);
      if (handoff && entry === b0 && !observedTarget) {
        observedTarget = true;
        expect(subagentRuns.get(b0.runId)).toBe(b0);
        handoffOrder.push("captured outcome");
        // Replace during the real awaited scope handoff, before synchronous publication.
        queueMicrotask(() => {
          if (!followup) {
            handoffComplete.reject(new Error("missing admitted follow-up"));
            return;
          }
          void followup
            .run(async () => {
              // This is the synchronous owner used by the lazy reactivation facade.
              expect(
                replaceSubagentRunAfterSteerCore({
                  previousRunId: b0.runId,
                  nextRunId: "publication-b1",
                  fallback: b0,
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
    const persistMarker = killRuntime.persistSubagentAbortedLastRun;
    vi.spyOn(killRuntime, "persistSubagentAbortedLastRun").mockImplementation(async (params) => {
      const result = await persistMarker(params);
      if (
        completeDuringDrain &&
        replace &&
        params.childSessionKey === rootKey &&
        !params.abortedLastRun
      ) {
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
        expect(b0.killReconciliation).toBeUndefined();
        childAdmission.release();
        if (replace) {
          await Promise.race([
            markerCleared.promise,
            pending.then((result) => {
              throw new Error(
                `Cancellation never reached marker cleanup: ${JSON.stringify(result)}`,
              );
            }),
          ]);
          expect(
            loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry.abortedLastRun,
          ).toBe(false);
        }
      }
      if (priorChildKill) {
        await vi.waitFor(() => {
          expect(resolveSubagentSessionStatus(subagentRuns.get("publication-first"))).toBe(
            "killed",
          );
        });
      }
      if (replace) {
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
          expect(subagentRuns.has(b0.runId)).toBe(false);
          expect(b1).toMatchObject({ taskRunId: b0.taskRunId, execution: { status: "running" } });
          if (typeof b0.generation !== "number") {
            throw new Error("Registration did not mint a run generation");
          }
          expect(b1.generation).toBeGreaterThan(b0.generation);
        }
      }
      childAdmission.release();
      releaseMarker.resolve();
      await pending;
      if (handoff) {
        expect(observedTarget, "admin resolved its root outcome").toBe(true);
        expect(handoffOrder, "admin captured its owner outcome").not.toEqual([]);
        await handoffComplete.promise;
        expect(handoffOrder.slice(0, 2)).toEqual(["captured outcome", "replacement"]);
      }
      const published = await admin.mock.results[0]!.value;
      expect(markerWaits).toBe(completeDuringDrain && replace ? 1 : 0);
      if (!replace) {
        expect(published).toMatchObject({
          found: true,
          targetState: {
            state: "terminal",
            task: { status: completeDuringDrain ? "succeeded" : "failed" },
          },
        });
        return;
      }
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
    } finally {
      cancellationClock?.mockRestore();
      releaseMarker.resolve();
      childAdmission.release();
      followup?.release();
      await pending;
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
