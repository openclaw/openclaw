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
  type createRunEntry as createLifecycleRunEntry,
  type LifecycleControllerFixtureOptions,
  type LifecycleFixtureWrite,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import {
  findAuthorizedSwarmCollectorRequest,
  findSwarmCollectorSession,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = SubagentLifecycleOptions;
type CompleteRun = (
  controller: SubagentLifecycleController,
  entry: SubagentRunRecord,
  overrides?: Omit<
    Partial<Parameters<SubagentLifecycleController["completeSubagentRun"]>[0]>,
    "runId"
  >,
) => Promise<void>;

export function registerLifecycleDeliveryReceiptCases({
  createRunEntry,
  createLifecycleController,
  completeRun,
  completeAndJoinCleanup,
  waitForLifecycleState,
}: {
  createRunEntry: (
    overrides?: Partial<SubagentRunRecord> & { endedAt?: number },
  ) => SubagentRunRecord;
  createLifecycleController: (
    options: {
      entry: SubagentRunRecord;
      runs?: Map<string, SubagentRunRecord>;
    } & Partial<LifecycleControllerFixtureOptions>,
  ) => SubagentLifecycleController;
  completeRun: CompleteRun;
  completeAndJoinCleanup: CompleteRun;
  waitForLifecycleState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
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
  } satisfies Parameters<CompleteRun>[2];

  function createReceiptFixture(
    delivery: SubagentAnnounceDeliveryResult,
    outcome: "delivered" | "retryable",
    overrides?: Parameters<typeof createRunEntry>[0],
    beforeWrite?: LifecycleControllerFixtureOptions["beforeWrite"],
  ) {
    const entry = createRunEntry({ expectsCompletionMessage: true, ...overrides });
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.(delivery);
        return outcome;
      },
    );
    const controller = createLifecycleController({
      entry,
      beforeWrite,
      runSubagentAnnounceFlow,
    });
    return { entry, controller, runSubagentAnnounceFlow };
  }

  it("delivers a restored legacy completion without mutating its unbound child session", async () => {
    const entry = createRunEntry({
      runId: "legacy-completion-without-identity",
      childSessionIdentity: undefined,
      expectsCompletionMessage: true,
    });
    const warn = vi.fn();
    const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async (params) => {
        expect(params.suppressChildSessionEffects).toBe(true);
        await params.onDeliveryResult?.({ delivered: true, path: "steered", deliveredAt: 12_300 });
        return "delivered";
      },
    );
    const controller = createLifecycleController({
      entry,
      warn,
      cleanupBrowserSessionsForLifecycleEnd,
      runSubagentAnnounceFlow,
    });

    await completeAndJoinCleanup(controller, entry, visibleCompletion);

    expect(readLifecycleRun(entry)).toMatchObject({
      execution: { status: "terminal", suppressSessionEffects: true },
      completion: { terminalReply: visibleCompletion.terminalReply },
      delivery: { status: "delivered", deliveredAt: 12_300 },
      cleanupCompletedAt: expect.any(Number),
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.completion?.resultText).toBe(
      "final completion reply",
    );
    expect(readLifecycleRun(entry).childSessionIdentity).toBeUndefined();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("records completion announcement timestamps from transcript delivery", async () => {
    const { entry, controller } = createReceiptFixture(
      { delivered: true, path: "steered", enqueuedAt: 4_100, deliveredAt: 12_300 },
      "delivered",
    );
    await expect(completeRun(controller, entry, visibleCompletion)).resolves.toBeUndefined();

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).delivery?.announcedAt).toBe(12_300),
    );
    expect(readLifecycleRun(entry).delivery?.enqueuedAt).toBe(4_100);
    expect(readLifecycleRun(entry).delivery?.deliveredAt).toBe(12_300);
    expect(readLifecycleRun(entry).delivery?.lastDropReason).toBeUndefined();
  });

  it.each([
    {
      name: "persists phase-only completion failure and steer-drop diagnostics",
      delivery: {
        delivered: false as const,
        path: "none" as const,
        phases: [
          {
            phase: "direct-primary" as const,
            delivered: false,
            path: "direct" as const,
            error: "primary refused",
          },
          {
            phase: "steer-fallback" as const,
            delivered: false,
            path: "none" as const,
            reason: "steer_dropped" as const,
            error: "steer refused",
          },
        ],
      },
      lastDropReason: "steer_dropped",
      lastError: "direct-primary: primary refused; steer-fallback: steer refused",
    },
    {
      name: "persists a direct steer-drop reason without rewriting it as sink_unavailable",
      delivery: {
        delivered: false as const,
        path: "none" as const,
        reason: "steer_dropped" as const,
      },
      lastDropReason: "steer_dropped",
      lastError: "steer_dropped",
    },
    {
      name: "persists sink_unavailable when announce mapping reports no viable requester",
      delivery: {
        delivered: false as const,
        path: "none" as const,
      },
      lastDropReason: "sink_unavailable",
      lastError: "delivery path none did not complete",
    },
  ])("$name", async ({ delivery, lastDropReason, lastError }) => {
    const persist = vi.fn();
    const { entry, controller } = createReceiptFixture(
      delivery,
      "retryable",
      { endedAt: 4_000, retainAttachmentsOnKeep: true },
      persist,
    );

    await expect(
      completeAndJoinCleanup(controller, entry, visibleCompletion),
    ).resolves.toBeUndefined();

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).delivery?.lastDropReason).toBe(lastDropReason),
    );
    expect(readLifecycleRun(entry).delivery?.lastError).toBe(lastError);
    expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runIds: [entry.runId] }));
  });

  it.each([
    {
      name: "persists a newly failed completion",
      reusePreviousError: false,
      previousDisposition: undefined,
      persistCalls: 1,
    },
    {
      name: "persists a changed disposition when completion diagnostics are otherwise unchanged",
      reusePreviousError: true,
      previousDisposition: undefined,
      persistCalls: 1,
    },
    {
      name: "does not persist unchanged completion diagnostics",
      reusePreviousError: true,
      previousDisposition: "retryable" as const,
      persistCalls: 0,
    },
  ])("$name before stalled announce bookkeeping settles", async (scenario) => {
    const lastError = "failed; visible_reply_missing";
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      delivery: {
        status: "pending",
        disposition: scenario.previousDisposition,
        ...(scenario.reusePreviousError ? { lastError } : {}),
      },
    });
    const receiptObserved = createDeferredCore();
    const announcePending = createDeferredCore();
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        const delivery: SubagentAnnounceDeliveryResult = {
          delivered: false,
          path: "direct",
          error: "failed",
          reason: "visible_reply_missing",
        };
        persist.mockClear();
        try {
          await announceParams.onDeliveryResult?.(delivery);
          receiptObserved.resolve();
        } catch (error) {
          receiptObserved.reject(error);
          throw error;
        }
        await announcePending.promise;
        return "retryable" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      beforeWrite: persist,
      runSubagentAnnounceFlow,
    });

    const join = observeRootWork();
    try {
      await expect(completeRun(controller, entry, visibleCompletion)).resolves.toBeUndefined();
      await receiptObserved.promise;
      expect(readLifecycleRun(entry).delivery?.disposition).toBe("retryable");
      expect(readLifecycleRun(entry).delivery?.lastDropReason).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.lastError).toBe(lastError);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(scenario.persistCalls);
      if (scenario.persistCalls > 0) {
        expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runIds: [entry.runId] }));
      }
    } finally {
      announcePending.resolve();
      await join();
    }
    expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
  });

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
    const announcePending = createDeferredCore();
    const sentChunks: number[] = [];
    const chunksFinished = createDeferredCore();
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        try {
          for (const chunk of [1, 2, 3]) {
            if (announceParams.isCompletionDeliveryAllowed?.() === false) {
              break;
            }
            sentChunks.push(chunk);
            await announceParams.onDeliveryResult?.({
              delivered: true,
              path: "direct",
              deliveredAt: 12_300,
            });
            await Promise.resolve();
          }
          chunksFinished.resolve();
        } catch (error) {
          chunksFinished.reject(error);
          throw error;
        }
        await announcePending.promise;
        return "delivered" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      beforeWrite: persist,
      runSubagentAnnounceFlow,
    });

    const join = observeRootWork();
    try {
      await completeRun(controller, entry, visibleCompletion);
      await chunksFinished.promise;
      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: "delivered",
        announcedAt: 12_300,
        deliveredAt: 12_300,
      });
      expect(readLifecycleRun(entry).delivery?.lastError).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.lastDropReason).toBeUndefined();
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runIds: [entry.runId] }));
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
      announcePending.resolve();
      await join();
    }
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
    expect(readLifecycleRun(entry).delivery?.nextAttemptAt).toBeUndefined();
    expect(readLifecycleRun(entry).label).toBe("updated while sending");
    expect(readLifecycleRun(entry).completion?.fallbackResultText).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.fallbackCapturedAt).toBeUndefined();
    expect(readLifecycleRun(entry).wakeOnDescendantSettle).toBeUndefined();
    expect(cleanupSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of cleanupSnapshots) {
      expect(snapshot.cleanupCompletedAt).toBeTypeOf("number");
      expect(snapshot.completion?.fallbackResultText).toBeUndefined();
      expect(snapshot.label).toBe("updated while sending");
    }
  });

  it("keeps a delivered receipt when a late failure arrives after the next turn starts", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true, generation: 1 });
    const runs = new Map([[entry.runId, entry]]);
    let onDeliveryResult: Parameters<
      LifecycleControllerParams["runSubagentAnnounceFlow"]
    >[0]["onDeliveryResult"];
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        onDeliveryResult = announceParams.onDeliveryResult;
        return "delivered" as const;
      },
    );
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
    const { entry, controller, runSubagentAnnounceFlow } = createReceiptFixture(
      {
        delivered: false,
        path: "direct",
        error: "prompt lock failed after visible send",
        terminal: true,
      },
      "delivered",
      { endedAt: 4_000, retainAttachmentsOnKeep: true },
    );

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expect(readLifecycleRun(entry).delivery?.lastError).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.payload).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.suspendedAt).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.suspendedReason).toBeUndefined();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });
}

export function registerRequesterAdmissionRetryTests({
  createRunEntry,
  createLifecycleController,
  useRetryTimers,
}: {
  createRunEntry: typeof createLifecycleRunEntry;
  createLifecycleController: (
    options: LifecycleControllerFixtureOptions,
  ) => SubagentLifecycleController;
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
      const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
        async (params) => {
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
        },
      );
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
        expect(countPendingDescendantRuns).toHaveBeenCalledOnce();
        expect(readLifecycleRun(entry).completion?.terminalReply).toEqual(terminalReply);
        expect(readLifecycleRun(entry).delivery).toMatchObject({
          status: "pending",
          payload: { childRunId: entry.runId, terminalReply },
          nextAttemptAt: 11_000,
        });
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        expect(readLifecycleRun(entry).wakeOnDescendantSettle).not.toBe(true);
        expect(controller.scheduledResumeTimers.size).toBe(1);

        releaseAdmission();
        await vi.advanceTimersByTimeAsync(1_000);
        await join(true);

        expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(entry.runId);
        expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
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
