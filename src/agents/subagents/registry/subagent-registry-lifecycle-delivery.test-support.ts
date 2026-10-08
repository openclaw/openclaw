import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "../announce/subagent-announce-dispatch.js";
import {
  readLifecycleRun,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
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
      name: "persists steer_dropped when announce mapping preserves a live-queue refusal",
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
      previousDropReason: undefined,
      reusePreviousError: false,
      previousDisposition: undefined,
      persistCalls: 1,
    },
    {
      name: "persists a changed drop reason when the direct error is unchanged",
      previousDropReason: "sink_unavailable" as const,
      reusePreviousError: true,
      previousDisposition: "retryable" as const,
      persistCalls: 1,
    },
    {
      name: "persists a changed disposition when completion diagnostics are otherwise unchanged",
      previousDropReason: "steer_dropped" as const,
      reusePreviousError: true,
      previousDisposition: undefined,
      persistCalls: 1,
    },
    {
      name: "does not persist unchanged completion diagnostics",
      previousDropReason: "steer_dropped" as const,
      reusePreviousError: true,
      previousDisposition: "retryable" as const,
      persistCalls: 0,
    },
  ])("$name before stalled announce bookkeeping settles", async (scenario) => {
    const lastError = "failed; visible_reply_missing; direct-primary: failed";
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      delivery: {
        status: "pending",
        disposition: scenario.previousDisposition,
        ...(scenario.reusePreviousError ? { lastError } : {}),
        ...(scenario.previousDropReason ? { lastDropReason: scenario.previousDropReason } : {}),
      },
    });
    const receiptObserved = createDeferredCore();
    const announcePending = createDeferredCore();
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        const delivery = await runSubagentAnnounceDispatch({
          expectsCompletionMessage: true,
          steer: async () => ({ status: "dropped" }),
          direct: async () => ({
            delivered: false,
            path: "direct",
            error: "failed",
            reason: "visible_reply_missing",
          }),
        });
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
      expect(readLifecycleRun(entry).delivery?.lastDropReason).toBe("steer_dropped");
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
    const persist = vi.fn();
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
    } finally {
      announcePending.resolve();
      await join();
    }
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
    expect(readLifecycleRun(entry).delivery?.nextAttemptAt).toBeUndefined();
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
