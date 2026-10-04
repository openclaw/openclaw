import { expectDefined as requireValue } from "openclaw/plugin-sdk/expect-runtime";
import { expect, it, vi, type Mock } from "vitest";
import {
  createTelegramSpooledReplayDeferredParticipant,
  recordTelegramMessageProcessingResult,
  runWithTelegramSpooledReplayUpdate,
  TelegramSpooledReplayProcessingError,
} from "../bot-processing-outcome.js";

type OffsetTracker = {
  onUpdateId: Mock<(id: number) => void | Promise<void>>;
  run: (context: Record<string, unknown>, next: () => Promise<void>) => Promise<void>;
};
export function registerTelegramSpooledRetryTests({
  setupUpdateOffsetTracker,
  flushTelegramTestMicrotasks,
  withTelegramSpooledReplayUpdate,
}: {
  setupUpdateOffsetTracker: (params: { lastUpdateId: number }) => Promise<OffsetTracker>;
  flushTelegramTestMicrotasks: () => Promise<void>;
  withTelegramSpooledReplayUpdate: <T>(update: object, fn: () => Promise<T>) => Promise<T>;
}) {
  it("persists recorded dispatch failures during normal polling", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 500,
    });

    const dispatchError = new Error("dispatch exploded");
    await runMiddlewareChain({ update: { update_id: 501 } }, async () => {
      recordTelegramMessageProcessingResult({
        kind: "failed-retryable",
        error: dispatchError,
      });
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501]);

    await runMiddlewareChain({ update: { update_id: 502 } }, async () => {});
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501, 502]);
  });

  it("rejects recorded dispatch failures during isolated spool replay", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 600,
    });

    const update = { update_id: 601 };
    const dispatchError = new Error("dispatch exploded");
    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runMiddlewareChain({ update }, async () => {
          recordTelegramMessageProcessingResult({
            kind: "failed-retryable",
            error: dispatchError,
          });
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: dispatchError,
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("keeps deferred spooled failures retryable in the same bot tracker", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 700,
    });

    const update = { update_id: 701 };
    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        const participant = createTelegramSpooledReplayDeferredParticipant("test:deferred");
        if (!participant) {
          throw new Error("expected spooled replay participant");
        }
      });
    });
    const deferredWork = replay.deferredWork;
    expect(deferredWork).toBeDefined();
    if (!deferredWork) {
      throw new Error("Expected deferred spooled work");
    }
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    deferredWork.settle({
      kind: "failed-retryable",
      error: new Error("deferred dispatch failed"),
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    let retried = false;
    await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        retried = true;
      });
    });
    await flushTelegramTestMicrotasks();
    expect(retried).toBe(true);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([701]);
  });

  it("retries a deferred spooled update that finishes after its owner aborts", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 710,
    });
    const owner = new AbortController();
    const update = { update_id: 711 };
    const replay = await runWithTelegramSpooledReplayUpdate(
      update,
      async () => {
        await runMiddlewareChain({ update }, async () => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:watchdog-owner-abort",
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
        });
      },
      {
        abortSignal: owner.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: vi.fn(),
      },
    );
    const deferredWork = requireValue(replay.deferredWork, "deferred spooled work");

    owner.abort(new Error("claim adoption watchdog fired"));
    deferredWork.settle({ kind: "completed" });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    const retryHandler = vi.fn();
    await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        retryHandler();
      });
    });
    await flushTelegramTestMicrotasks();
    expect(retryHandler).toHaveBeenCalledTimes(1);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([711]);
  });
}
