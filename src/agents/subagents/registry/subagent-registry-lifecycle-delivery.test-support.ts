import { expect, it, onTestFinished, vi } from "vitest";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  closeSessionControllerAdmission,
} from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as sessionEntryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import * as cleanupPolicy from "./subagent-registry-cleanup.js";
import {
  mutateLifecycleRun,
  readLifecycleRun,
  expectUndefinedFields,
  type CompleteLifecycleRun,
  type LifecycleTestDrivers,
  type LifecycleFixtureWrite,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import {
  findAuthorizedSwarmCollectorRequest,
  findSwarmCollectorSession,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type AnnounceFlow = SubagentLifecycleOptions["runSubagentAnnounceFlow"];

function stalledAnnounce(
  outcome: "delivered" | "retryable",
  send: (params: Parameters<AnnounceFlow>[0]) => Promise<void>,
) {
  const observed = createDeferredCore();
  const pending = createDeferredCore();
  const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async (params) => {
    try {
      await send(params);
      observed.resolve();
    } catch (error) {
      observed.reject(error);
      throw error;
    }
    await pending.promise;
    return outcome;
  });
  return { observed, pending, runSubagentAnnounceFlow };
}

export function registerLifecycleDeliveryReceiptCases({
  createRunEntry,
  createLifecycleController,
  completeRun,
  completeAndJoinCleanup,
  waitForLifecycleState,
}: LifecycleTestDrivers & {
  completeRun: CompleteLifecycleRun;
  completeAndJoinCleanup: CompleteLifecycleRun;
}) {
  it("authorizes and completes both collectors sharing a raw key across agents", async () => {
    const entries = ["main", "research"].map((childAgentId) =>
      createRunEntry({
        runId: `collector-${childAgentId}`,
        childSessionKey: "global",
        childAgentId,
        childSessionIdentity: { sessionId: `session-${childAgentId}` },
        collect: true,
        groupId: "shared-group",
        swarmLaunchIdempotencyKey: `launch-${childAgentId}`,
        expectsCompletionMessage: false,
      }),
    );
    onTestFinished(() => subagentRuns.clear());
    for (const entry of entries) {
      subagentRuns.set(entry.runId, entry);
    }
    const controller = createLifecycleController({
      entry: entries[0]!,
      runs: subagentRuns,
      captureSubagentCompletionReply: vi
        .fn()
        .mockResolvedValueOnce("main result")
        .mockResolvedValueOnce("research result"),
    });
    for (const entry of entries) {
      expect(
        findAuthorizedSwarmCollectorRequest({
          childSessionKey: entry.childSessionKey,
          childAgentId: entry.childAgentId,
          idempotencyKey: entry.swarmLaunchIdempotencyKey,
        }),
      ).toMatchObject({ runId: entry.runId });
      await completeRun(controller, entry, { terminalReply: undefined });
    }
    for (const entry of entries) {
      expect(findSwarmCollectorSession(entry.childSessionKey, entry.childAgentId)).toMatchObject({
        runId: entry.runId,
        collectorCompletion: { status: "done" },
        completion: { resultText: `${entry.childAgentId} result` },
      });
    }
    expect(findSwarmCollectorSession("global")).toBeUndefined();
    subagentRuns.delete(entries[0]!.runId);
    expect(findSwarmCollectorSession("global", "research")).toMatchObject({
      runId: entries[1]!.runId,
      collectorCompletion: { status: "done" },
    });
  });

  const visibleCompletion = {
    triggerCleanup: true,
    terminalReply: { disposition: "visible", text: "final completion reply" },
  } satisfies Parameters<CompleteLifecycleRun>[2];

  function createReceiptFixture(
    delivery: SubagentAnnounceDeliveryResult,
    outcome: "delivered" | "retryable",
    overrides?: Parameters<typeof createRunEntry>[0],
  ) {
    const entry = createRunEntry({ expectsCompletionMessage: true, ...overrides });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow: async (announceParams) => {
        await announceParams.onDeliveryResult?.(delivery);
        return outcome;
      },
    });
    return { entry, controller };
  }

  it("delivers a restored legacy completion without mutating its unbound child session", async () => {
    const entry = createRunEntry({
      runId: "legacy-completion-without-identity",
      childSessionIdentity: undefined,
      expectsCompletionMessage: true,
    });
    const warn = vi.fn();
    const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async (params) => {
      expect(params.suppressChildSessionEffects).toBe(true);
      await params.onDeliveryResult?.({ delivered: true, path: "steered", deliveredAt: 12_300 });
      return "delivered";
    });
    const controller = createLifecycleController({
      entry,
      warn,
      cleanupBrowserSessionsForLifecycleEnd,
      runSubagentAnnounceFlow,
    });

    await completeAndJoinCleanup(controller, entry, visibleCompletion);

    expect(readLifecycleRun(entry)).toMatchObject({
      execution: { status: "terminal", suppressSessionEffects: true },
      delivery: { status: "delivered", deliveredAt: 12_300 },
      cleanupCompletedAt: expect.any(Number),
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.completion).toMatchObject({
      terminalReply: visibleCompletion.terminalReply,
      resultText: "final completion reply",
    });
    expect(readLifecycleRun(entry).childSessionIdentity).toBeUndefined();
    expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<SubagentAnnounceDeliveryResult>, string, string]>([
    [
      "phase-only failure and steer-drop diagnostics",
      {
        phases: [
          { phase: "direct-primary", delivered: false, path: "direct", error: "primary refused" },
          {
            phase: "steer-fallback",
            delivered: false,
            path: "none",
            reason: "steer_dropped",
            error: "steer refused",
          },
        ],
      },
      "steer_dropped",
      "direct-primary: primary refused; steer-fallback: steer refused",
    ],
    ["direct steer-drop reason", { reason: "steer_dropped" }, "steer_dropped", "steer_dropped"],
    ["no viable requester", {}, "sink_unavailable", "delivery path none did not complete"],
  ])("persists %s", async (_name, details, lastDropReason, lastError) => {
    const { entry, controller } = createReceiptFixture(
      { delivered: false, path: "none", ...details },
      "retryable",
      { endedAt: 4_000, retainAttachmentsOnKeep: true },
    );

    await completeAndJoinCleanup(controller, entry, visibleCompletion);

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).delivery?.lastDropReason).toBe(lastDropReason),
    );
    expect(readLifecycleRun(entry).delivery).toMatchObject({ lastError, status: "suspended" });
  });

  it.each([
    ["new failure", false, undefined, 1],
    ["changed disposition", true, undefined, 1],
    ["unchanged diagnostics", true, "retryable", 0],
  ] as const)(
    "persists %s before stalled announce bookkeeping settles",
    async (_name, reusePreviousError, previousDisposition, persistCalls) => {
      const lastError = "failed; visible_reply_missing";
      const persist = vi.fn();
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        delivery: {
          status: "pending",
          disposition: previousDisposition,
          ...(reusePreviousError ? { lastError } : {}),
        },
      });
      const announce = stalledAnnounce("retryable", async (announceParams) => {
        persist.mockClear();
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "failed",
          reason: "visible_reply_missing",
        });
      });
      const controller = createLifecycleController({
        entry,
        beforeWrite: persist,
        runSubagentAnnounceFlow: announce.runSubagentAnnounceFlow,
      });

      const join = observeRootWork();
      try {
        await completeRun(controller, entry, visibleCompletion);
        await announce.observed.promise;
        expect(readLifecycleRun(entry).delivery).toMatchObject({
          disposition: "retryable",
          lastError,
        });
        expectUndefinedFields(readLifecycleRun(entry).delivery, ["lastDropReason"]);
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        expect(persist).toHaveBeenCalledTimes(persistCalls);
      } finally {
        announce.pending.resolve();
        await join();
      }
      expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
    },
  );

  it("persists identified completion delivery while completing the active multipart send", async () => {
    const cleanupSnapshots: SubagentRunRecord[] = [];
    const persist = vi.fn(({ postimages }: LifecycleFixtureWrite) => {
      for (const postimage of postimages.values()) {
        if (postimage) {
          cleanupSnapshots.push(postimage);
        }
      }
    });
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      delivery: {
        status: "pending",
        lastError: "earlier delivery failed",
        lastDropReason: "sink_unavailable",
        nextAttemptAt: 13_000,
      },
    });
    const sentChunks: number[] = [];
    const announce = stalledAnnounce("delivered", async (announceParams) => {
      for (const chunk of [1, 2, 3]) {
        if (announceParams.isCompletionDeliveryAllowed?.() === false) {
          break;
        }
        sentChunks.push(chunk);
        await announceParams.onDeliveryResult?.({
          delivered: true,
          path: "direct",
          enqueuedAt: 4_100,
          deliveredAt: 12_300,
        });
        await Promise.resolve();
      }
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: persist,
      runSubagentAnnounceFlow: announce.runSubagentAnnounceFlow,
    });

    const join = observeRootWork();
    try {
      await completeRun(controller, entry, visibleCompletion);
      await announce.observed.promise;
      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: "delivered",
        enqueuedAt: 4_100,
        announcedAt: 12_300,
        deliveredAt: 12_300,
      });
      expectUndefinedFields(readLifecycleRun(entry).delivery, ["lastError", "lastDropReason"]);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect.soft(sentChunks).toEqual([1, 2, 3]);
      await mutateLifecycleRun(entry, (draft) => {
        draft.label = "updated while sending";
        draft.completion = {
          ...draft.completion,
          required: true,
          fallbackResultText: "earlier fallback",
          fallbackCapturedAt: 12_000,
        };
        draft.wakeOnDescendantSettle = true;
      });
      cleanupSnapshots.length = 0;
    } finally {
      announce.pending.resolve();
      await join();
    }
    const completed = readLifecycleRun(entry);
    expect(completed.cleanupCompletedAt).toBeTypeOf("number");
    expect(completed.label).toBe("updated while sending");
    expectUndefinedFields(completed.delivery, ["nextAttemptAt"]);
    expectUndefinedFields(completed.completion, ["fallbackResultText", "fallbackCapturedAt"]);
    expectUndefinedFields(completed, ["wakeOnDescendantSettle"]);
    expect(cleanupSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of cleanupSnapshots) {
      expect(snapshot.cleanupCompletedAt).toBeTypeOf("number");
      expect(snapshot.label).toBe("updated while sending");
      expect(snapshot.completion?.fallbackResultText).toBeUndefined();
    }
  });

  it("keeps a delivered receipt when a late failure arrives after the next turn starts", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true, generation: 1 });
    const runs = new Map([[entry.runId, entry]]);
    let onDeliveryResult: Parameters<AnnounceFlow>[0]["onDeliveryResult"];
    const runSubagentAnnounceFlow: AnnounceFlow = vi.fn(async (announceParams) => {
      onDeliveryResult = announceParams.onDeliveryResult;
      return "delivered" as const;
    });
    const retireSupersededRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      retireSupersededRun,
      runSubagentAnnounceFlow,
    });

    await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });
    const delivered = readLifecycleRun(entry).delivery;
    expect(delivered?.status).toBe("delivered");
    const newer = createRunEntry({
      runId: "run-2",
      childSessionKey: entry.childSessionKey,
      generation: 2,
    });
    runs.set(newer.runId, newer);

    await onDeliveryResult?.({ delivered: false, path: "none" });

    expect(readLifecycleRun(entry).delivery).toEqual(delivered);
    expect(retireSupersededRun).not.toHaveBeenCalled();
    expect(runs.get(newer.runId)).toBe(newer);
  });

  it("finalizes terminal visible-send failures without scheduling completion retry", async () => {
    const { entry, controller } = createReceiptFixture(
      {
        delivered: false,
        path: "direct",
        error: "prompt lock failed after visible send",
        terminal: true,
      },
      "delivered",
      { endedAt: 4_000, retainAttachmentsOnKeep: true },
    );

    await completeRun(controller, entry, { triggerCleanup: true });

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expectUndefinedFields(readLifecycleRun(entry).delivery, [
      "lastError",
      "payload",
      "suspendedAt",
      "suspendedReason",
    ]);
  });
}

export function registerRequesterAdmissionRetryTests({
  createRunEntry,
  createLifecycleController,
  useRetryTimers,
}: Omit<LifecycleTestDrivers, "waitForLifecycleState"> & {
  useRetryTimers: () => Promise<void>;
}) {
  it.each(["after cleanup", "during finalization"] as const)(
    "delivers the retained result without descendants when requester admission releases %s",
    async (releaseAt) => {
      await useRetryTimers();
      vi.setSystemTime(10_000);
      const actualPolicy = await vi.importActual<typeof cleanupPolicy>(
        "./subagent-registry-cleanup.js",
      );
      const decision = vi
        .spyOn(cleanupPolicy, "resolveDeferredCleanupDecision")
        .mockImplementation(actualPolicy.resolveDeferredCleanupDecision);
      const terminalReply = { disposition: "visible", text: "Retained child result" } as const;
      const entry = createRunEntry({
        endedAt: Date.now(),
        outcome: { status: "ok" },
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        completion: { required: true, terminalReply },
      });
      const delivered = vi.fn();
      const admissionFailures: unknown[] = [];
      const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async (params) => {
        const input = params.controllerInput;
        if (!input?.target) {
          throw new Error("Completion has no requester controller input");
        }
        // Exercise the real requester gate; only the final transport is synthetic.
        const effect = await beginSessionEffect({
          target: input.target,
          sourceInput: input,
        }).catch((error: unknown) => {
          admissionFailures.push(error);
          throw error;
        });
        try {
          return await effect.run(() =>
            withSessionTurn(
              {
                sessionKey: input.mailbox.key,
                sessionId: input.target?.incarnation,
                target: input.target,
                controllerInput: input,
              },
              async () => {
                delivered(params.terminalReply);
                await params.onDeliveryResult?.({
                  delivered: true,
                  path: "direct",
                  disposition: "delivered",
                });
                return "delivered" as const;
              },
            ),
          );
        } finally {
          effect.release();
        }
      });
      let releaseAdmission = () => {};
      const countPendingDescendantRuns = vi.fn(async () => {
        if (releaseAt === "during finalization") {
          releaseAdmission();
        }
        return 0;
      });
      const resumeSubagentRun = vi.fn(() =>
        controller.startSubagentAnnounceCleanupFlow(readLifecycleRun(entry)),
      );
      const controller = createLifecycleController({
        entry,
        runSubagentAnnounceFlow,
        countPendingDescendantRuns,
        resumeSubagentRun,
      });
      const requester = await sessionEntryRuntime.loadRequesterSessionEntry(
        entry.requesterSessionKey,
        entry.requesterAgentId,
      );
      if (!requester.entry?.sessionId || !requester.storePath) {
        throw new Error("Requester fixture has no stored session");
      }
      const unavailable = new Error("Requester session admission is temporarily closed");
      releaseAdmission = closeSessionControllerAdmission({
        target: captureSessionTarget({
          storeScope: requester.storePath,
          sessionKey: requester.canonicalKey,
          agentId: requester.agentId,
          incarnation: requester.entry.sessionId,
        }),
        reason: unavailable,
      });
      const join = observeRootWork();
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
        await join(true);

        expect(admissionFailures).toEqual([unavailable]);
        expect(delivered).not.toHaveBeenCalled();
        const waiting = readLifecycleRun(entry);
        expect(waiting.completion?.terminalReply).toEqual(terminalReply);
        expect(waiting.delivery).toMatchObject({
          status: "pending",
          payload: { childRunId: entry.runId, terminalReply },
          nextAttemptAt: 11_000,
        });
        expect(waiting.cleanupCompletedAt).toBeUndefined();
        expect(waiting.wakeOnDescendantSettle).not.toBe(true);
        expect(controller.scheduledResumeTimers.size).toBe(1);

        releaseAdmission();
        await vi.advanceTimersByTimeAsync(1_000);
        await join(true);

        expect(delivered).toHaveBeenCalledExactlyOnceWith(terminalReply);
        expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
        expect(controller.scheduledResumeTimers.size).toBe(0);
      } finally {
        releaseAdmission();
        await join();
        controller.clearRuntimeState();
        decision.mockRestore();
        vi.useRealTimers();
      }
    },
  );
}
