import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { retireSessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { reserveSubagentControllerSource } from "../announce/subagent-announce-controller-source.js";
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

async function readVisibleChildResults(entry: SubagentRunRecord) {
  const scope = {
    agentId: entry.requesterAgentId,
    sessionKey: entry.requesterSessionKey,
    storePath: entry.requesterStorePath,
  };
  const events = await loadTranscriptEvents({
    ...scope,
    sessionId: loadSessionEntry(scope)!.sessionId,
  });
  return events.filter(
    (event) =>
      isRecord(event) && event.customType === "subagent-completion" && event.display === true,
  );
}

function stalledAnnounce(
  outcome: "delivered" | "undelivered",
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
}: LifecycleTestDrivers & {
  completeRun: CompleteLifecycleRun;
  completeAndJoinCleanup: CompleteLifecycleRun;
}) {
  it("settles a restored consumed private completion without announcing it again", async () => {
    const entry = createRunEntry({
      runId: "restored-private-result",
      endedAt: Date.now(),
      outcome: { status: "ok" },
      completionTarget: "parent",
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "already consumed result" },
      delivery: {
        status: "pending",
        requesterDelivery: { state: "consumed", runId: "requester-continuation", at: Date.now() },
      },
    });
    const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async () => "delivered");
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    });
    const visibleResultsBefore = await readVisibleChildResults(entry);
    const join = observeRootWork();
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    await join();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery).toMatchObject({
      status: "delivered",
      requesterDelivery: entry.delivery?.requesterDelivery,
    });
    expect(await readVisibleChildResults(entry)).toEqual(visibleResultsBefore);
  });

  it("settles an undelivered completion when process custody retires", async () => {
    const entry = createRunEntry({
      endedAt: Date.now(),
      outcome: { status: "ok" },
      completionTarget: "parent",
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "retained result" },
    });
    const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async () => {
      subagentRuns.retireCompletionAuthority(readLifecycleRun(entry));
      return "undelivered";
    });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    });
    const join = observeRootWork();
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    await join();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: "delivered",
      disposition: "delivered",
      payload: undefined,
    });
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
  });

  it.each([false, true])(
    "records private transcript consumption before cancellation (consumed: %s)",
    async (consumed) => {
      const entry = createRunEntry({
        runId: `private-cancellation-${consumed}`,
        completionTarget: "parent",
        expectsCompletionMessage: true,
      });
      const releaseRequester = createDeferredCore();
      const receiptStarted = createDeferredCore();
      const releaseReceipt = createDeferredCore();
      onTestFinished(() => releaseReceipt.resolve());
      const runSubagentAnnounceFlow = vi.fn<AnnounceFlow>(async (params) => {
        expect(readLifecycleRun(entry).delivery?.requesterDelivery).toMatchObject({
          state: "waiting",
          blockingRunId: "live-requester-settle",
        });
        releaseRequester.resolve();
        const consumption = consumed
          ? params.controllerInput!.onTranscriptCommitted!("requester-continuation")
          : undefined;
        if (consumed) {
          await receiptStarted.promise;
          expect(readLifecycleRun(entry).delivery?.requesterDelivery?.state).toBe("waiting");
        }
        const settlement = params.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "delivery_suppressed",
          error: "private requester continuation was cancelled",
        });
        releaseReceipt.resolve();
        await settlement;
        await consumption;
        if (consumed) {
          expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery).toMatchObject({
            status: "delivered",
            requesterDelivery: {
              state: "consumed",
              runId: "requester-continuation",
            },
          });
        }
        return "undelivered";
      });
      const controller = createLifecycleController({
        entry,
        beforeWrite: async ({ postimages }) => {
          if (
            postimages.get(entry.runId)?.delivery?.requesterDelivery?.state === "consumed" &&
            postimages.get(entry.runId)?.delivery?.status === "pending"
          ) {
            receiptStarted.resolve();
            await releaseReceipt.promise;
          }
        },
        runSubagentAnnounceFlow,
        maybeWakeRequesterAfterAllChildrenSettled: async () => false,
      });
      const visibleResultsBefore = await readVisibleChildResults(entry);
      const blocker = await reserveSubagentControllerSource(
        entry,
        "synthetic-live-requester",
        "live-requester-settle",
      );
      expect(blocker).toBeDefined();
      const started = createDeferredCore();
      const requester = withSessionTurn(
        {
          sessionKey: entry.requesterSessionKey,
          target: blocker!.target,
          controllerInput: blocker,
        },
        async () => {
          started.resolve();
          await releaseRequester.promise;
        },
      );
      onTestFinished(async () => {
        releaseRequester.resolve();
        await requester;
        retireSessionControllerInput(blocker!);
      });
      await started.promise;
      await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });
      expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
      expect(readLifecycleRun(entry).delivery?.requesterDelivery?.state).toBe(
        consumed ? "consumed" : undefined,
      );
      controller.startSubagentAnnounceCleanupFlow(readLifecycleRun(entry));
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      if (consumed) {
        expect(await readVisibleChildResults(entry)).toEqual(visibleResultsBefore);
      }
    },
  );

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

  it.each([
    ["new failure", false, undefined, 1],
    ["changed disposition", true, "session_queued", 1],
  ] as const)(
    "persists %s before stalled announce bookkeeping settles",
    async (_name, reusePreviousError, previousDisposition, persistCalls) => {
      const lastError = "failed";
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
      const announce = stalledAnnounce("undelivered", async (announceParams) => {
        persist.mockClear();
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "failed",
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
          disposition: undefined,
          lastError,
        });
        expectUndefinedFields(readLifecycleRun(entry).delivery, ["lastDropReason"]);
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        expect(persist).toHaveBeenCalledTimes(persistCalls);
      } finally {
        announce.pending.resolve();
        await join();
      }
      expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
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
}
