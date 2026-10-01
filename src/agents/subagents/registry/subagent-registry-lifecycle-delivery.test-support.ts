import { expect, it, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "../announce/subagent-announce-dispatch.js";
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
    } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  completeRun: CompleteRun;
  completeAndJoinCleanup: CompleteRun;
  waitForLifecycleState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
}) {
  it("records completion announcement timestamps from transcript delivery", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const delivery: SubagentAnnounceDeliveryResult = {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 12_300,
    };
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.(delivery);
        return "delivered" as const;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    await waitForLifecycleState(() => expect(entry.delivery?.announcedAt).toBe(12_300));
    expect(entry.delivery?.enqueuedAt).toBe(4_100);
    expect(entry.delivery?.deliveredAt).toBe(12_300);
    expect(entry.delivery?.lastDropReason).toBeUndefined();
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
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.(delivery);
        return "retryable" as const;
      },
    );

    const controller = createLifecycleController({
      entry,
      persistOrThrow: persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      completeAndJoinCleanup(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    await waitForLifecycleState(() => expect(entry.delivery?.lastDropReason).toBe(lastDropReason));
    expect(entry.delivery?.lastError).toBe(lastError);
    expect(entry.delivery?.status).toBe("suspended");
    expect(persist).toHaveBeenCalledWith(entry.runId);
  });

  it.each([
    {
      name: "persists a newly failed completion",
      previousDropReason: undefined,
      reusePreviousError: false,
      persistCalls: 1,
    },
    {
      name: "persists a changed drop reason when the direct error is unchanged",
      previousDropReason: "sink_unavailable" as const,
      reusePreviousError: true,
      persistCalls: 1,
    },
    {
      name: "does not persist unchanged completion diagnostics",
      previousDropReason: "steer_dropped" as const,
      reusePreviousError: true,
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
        ...(scenario.reusePreviousError ? { lastError } : {}),
        ...(scenario.previousDropReason ? { lastDropReason: scenario.previousDropReason } : {}),
      },
    });
    const receiptObserved = createDeferredCore();
    let releaseAnnounce!: () => void;
    const announcePending = new Promise<void>((resolve) => {
      releaseAnnounce = resolve;
    });
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
        await announcePending;
        return "retryable" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      persistOrThrow: persist,
      runSubagentAnnounceFlow,
    });

    const join = observeRootWork();
    try {
      await expect(
        completeRun(controller, entry, {
          triggerCleanup: true,
          terminalReply: { disposition: "visible", text: "final completion reply" },
        }),
      ).resolves.toBeUndefined();
      await receiptObserved.promise;
      expect(entry.delivery?.disposition).toBe("retryable");
      expect(entry.delivery?.lastDropReason).toBe("steer_dropped");
      expect(entry.delivery?.lastError).toBe(lastError);
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(scenario.persistCalls);
      if (scenario.persistCalls > 0) {
        expect(persist).toHaveBeenCalledWith(entry.runId);
      }
    } finally {
      releaseAnnounce();
      await join();
    }
    expect(entry.delivery?.status).toBe("suspended");
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
    let releaseAnnounce!: () => void;
    const announcePending = new Promise<void>((resolve) => {
      releaseAnnounce = resolve;
    });
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
        await announcePending;
        return "delivered" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      persistOrThrow: persist,
      runSubagentAnnounceFlow,
    });

    const join = observeRootWork();
    try {
      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      });
      await chunksFinished.promise;
      expect(entry.delivery?.status).toBe("delivered");

      expect(entry.delivery).toMatchObject({
        status: "delivered",
        announcedAt: 12_300,
        deliveredAt: 12_300,
      });
      expect(entry.delivery?.lastError).toBeUndefined();
      expect(entry.delivery?.lastDropReason).toBeUndefined();
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenCalledWith(entry.runId);
      expect.soft(sentChunks).toEqual([1, 2, 3]);
    } finally {
      releaseAnnounce();
      await join();
    }
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(entry.delivery?.nextAttemptAt).toBeUndefined();
  });

  it("keeps a late superseded-delivery retirement root-admitted", async () => {
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
    let releaseRetirement = () => {};
    const retirementPending = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const retireSupersededRun = vi.fn(async () => {
      await retirementPending;
    });
    const controller = createLifecycleController({
      entry,
      runs,
      retireSupersededRun,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    const newer = createRunEntry({
      runId: "run-2",
      childSessionKey: entry.childSessionKey,
      generation: 2,
    });
    runs.set(newer.runId, newer);

    await onDeliveryResult?.({ delivered: false, path: "none" });

    await waitForLifecycleState(() =>
      expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    releaseRetirement();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("finalizes terminal visible-send failures without scheduling completion retry", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "prompt lock failed after visible send",
          terminal: true,
        });
        return "delivered" as const;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.delivery?.status).toBe("delivered");
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.delivery?.payload).toBeUndefined();
    expect(entry.delivery?.suspendedAt).toBeUndefined();
    expect(entry.delivery?.suspendedReason).toBeUndefined();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });
}
