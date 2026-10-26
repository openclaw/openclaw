// Telegram ingress coalescing regression: durable queue → core drain → grammY → inbound buffer.
// Both Telegram inbound buffers (album, forward-burst debounce) defer their spooled
// participant the same way, so both depend on deferredLaneOccupancy="release" to admit
// later same-lane members. Cover them together — a lane regression breaks both at once.
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type {
  TelegramIngressMonitorOptions,
  TelegramIngressResources,
} from "./telegram-ingress-coalescing-fixture.test-support.js";
import {
  holdForwardWindow,
  photoUpdate,
  forwardedPhotoUpdate,
  forwardedTextUpdate,
  textUpdate,
} from "./telegram-ingress-coalescing.test-support.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(
    async (
      _ctx: MsgContext,
      _abortSignal?: AbortSignal,
      _turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"],
    ) => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
  ),
);
const inboundTurns = vi.hoisted(() => ({
  active: new Set<Promise<void>>(),
}));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-album-ingress-");
const saveRemoteMedia = vi.hoisted(() =>
  vi.fn(async (params: { filePathHint?: string }) => ({
    id: path.basename(params.filePathHint ?? "photo"),
    path: `/tmp/${path.basename(params.filePathHint ?? "photo.jpg")}`,
    size: 4,
    contentType: "image/jpeg",
  })),
);

vi.mock("./fetch.js", () => ({
  resolveTelegramApiBase: (apiRoot?: string) => apiRoot ?? "https://api.telegram.org",
  resolveTelegramFetch: (proxyFetch?: typeof fetch) => proxyFetch ?? globalThis.fetch,
  resolveTelegramTransport: (proxyFetch?: typeof fetch) => {
    const fetchImpl = proxyFetch ?? globalThis.fetch;
    return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
  },
  shouldRetryTelegramTransportFallback: () => false,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const turn = (async () => {
        return await runTelegramChannelInboundEventWithHarness(
          actual,
          params,
          async (dispatchParams) => {
            return await downstreamTurns(
              dispatchParams.ctx,
              dispatchParams.replyOptions?.abortSignal,
              dispatchParams.replyOptions?.turnAdoptionLifecycle,
            );
          },
        );
      })();
      const settled = turn.then(
        () => {},
        () => {},
      );
      inboundTurns.active.add(settled);
      void settled.then(() => {
        inboundTurns.active.delete(settled);
      });
      return await turn;
    },
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    saveRemoteMedia,
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

// Preserve production initialization order before the fixture imports those modules.
await import("./bot.js");
await import("openclaw/plugin-sdk/reply-runtime");
await import("./telegram-ingress-drain-factory.js");
await import("./runtime.js");
await import("./runtime.test-support.js");
const ingressSpool = await import("./telegram-ingress-spool.js");
const { openTelegramIngressQueue, telegramQueueEventId } = ingressSpool;
const { writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.test-support.js");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const processingOutcome = await import("./bot-processing-outcome.js");
const {
  admitAlbum,
  assertSpoolTombstoned,
  createDownstreamTurnFixture,
  createIngressMonitor,
  flushHeldQuietWindow,
  interceptReplayGuard,
  resetTelegramIngressRuntime,
  runtimeErrors,
  releaseIngressCase,
  spoolBehindPausedPump,
  expectOnlyPending,
  useIngressTimers,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");
const {
  captureNextDownstreamTurn,
  awaitSingleDownstreamTurn,
  holdFirstDownstreamTurn,
  holdDownstreamLane,
} = createDownstreamTurnFixture(downstreamTurns);

describe("Telegram durable ingress coalescing", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let activeResources: TelegramIngressResources[];

  beforeEach(async () => {
    stateDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    activeResources = [];
    runtimeErrors.length = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    saveRemoteMedia.mockReset();
    resetTelegramIngressRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await releaseIngressCase(activeResources, inboundTurns.active, stateDir);
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  async function createMonitor(options: TelegramIngressMonitorOptions = {}) {
    const resources = await createIngressMonitor(stateDir, options);
    activeResources.push(resources);
    return resources;
  }

  const tombstones = (...updateIds: number[]) => assertSpoolTombstoned({ stateDir, updateIds });
  async function spool(...updates: Parameters<typeof writeTelegramSpooledUpdate>[0]["update"][]) {
    for (const update of updates) {
      await writeTelegramSpooledUpdate({ stateDir, update });
    }
  }

  it("keeps a timed-out update retryable while its original middleware is still waiting", async ({
    signal,
  }) => {
    // The monitor captures Date.now at construction, so install the clock first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const enteredBlocker = createDeferred<void>();
    const finishBlocker = createDeferred<void>();
    downstreamTurns.mockImplementationOnce(async () => {
      enteredBlocker.resolve();
      await finishBlocker.promise;
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const { monitor, bot } = await createMonitor({
      adoptionStallTimeoutMs: 300_000,
      pollIntervalMs: 60_000,
      onRuntimeError: vi.fn(),
    });
    const blocker = bot.handleUpdate(
      textUpdate({ updateId: 801, messageId: 1, text: "busy turn" }),
    );
    try {
      await withinTest(enteredBlocker.promise, signal);
      const handleUpdate = vi.spyOn(bot, "handleUpdate");
      const queued = textUpdate({ updateId: 802, messageId: 2, text: "deliver this later" });
      const tail = textUpdate({ updateId: 803, messageId: 3, text: "deliver after the retry" });
      const eventId = telegramQueueEventId(802);
      const queue = openTelegramIngressQueue({ stateDir });
      monitor.start();

      await withinTest(monitor.admit(queued), signal);
      await withinTest(
        vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1)),
        signal,
      );
      await withinTest(vi.advanceTimersByTimeAsync(300_000), signal);
      await withinTest(
        vi.waitFor(async () => {
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: eventId, attempts: 1, lastError: expect.stringContaining("handler-timeout") },
          ]);
        }),
        signal,
      );

      await withinTest(monitor.admit(tail), signal);
      await withinTest(vi.advanceTimersByTimeAsync(1_000), signal);
      monitor.requestDrain();
      await withinTest(
        vi.waitFor(() => {
          expect(
            handleUpdate.mock.calls.filter(([update]) => update.update_id === 802),
          ).toHaveLength(2);
        }),
        signal,
      );
      // A pending duplicate must not let its same-lane follower overtake it.
      await withinTest(
        vi.waitFor(async () => {
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: eventId, attempts: 2, payload: { update: queued } },
            { id: telegramQueueEventId(803), attempts: 0 },
          ]);
        }),
        signal,
      );
      expect(downstreamTurns).toHaveBeenCalledTimes(1);

      finishBlocker.resolve();
      await blocker;
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(2_000);
      monitor.requestDrain();
      await monitor.waitForIdle();
      expect(downstreamTurns).toHaveBeenCalledTimes(3);
      expect(downstreamTurns.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "busy turn",
        "deliver this later",
        "deliver after the retry",
      ]);
      await tombstones(802, 803);
      const duplicate = await processingOutcome.runWithTelegramUpdateProcessingFrame(() =>
        bot.handleUpdate(queued),
      );
      expect(duplicate.result).toEqual({ kind: "skipped" });
      expect(downstreamTurns).toHaveBeenCalledTimes(3);
    } finally {
      finishBlocker.resolve();
      await blocker;
      await monitor.stop();
    }
  });

  it("keeps a later album alive and ordered behind a slowly adopting album", async ({ signal }) => {
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 1_000 });
    const { headDispatched, releaseHead } = holdFirstDownstreamTurn();
    useIngressTimers();
    monitor.start();
    try {
      await withinTest(admitAlbum(monitor, "A", 1_001), signal);
      // Freeze the claim clock while dispatch finishes its real worker I/O.
      await withinTest(headDispatched.promise, signal);
      await withinTest(admitAlbum(monitor, "B", 1_003), signal);
      await withinTest(vi.advanceTimersByTimeAsync(3_000), signal);
      expect(downstreamTurns, "Album B must wait for album A's adoption").toHaveBeenCalledOnce();
      releaseHead.resolve();
      await withinTest(monitor.waitForDeferredClaims(), signal);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Album A",
        "Album B",
      ]);
      await tombstones(1_001, 1_002, 1_003, 1_004);
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseHead.resolve();
      await monitor.stop();
    }
  });

  it("keeps a later same-sender forward batch alive behind a deferred batch", async ({
    signal,
  }) => {
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 3_000 });
    const { releaseHead, turnsDeferred } = holdDownstreamLane();
    useIngressTimers();
    monitor.start();
    try {
      await withinTest(
        monitor.admit(forwardedTextUpdate({ updateId: 1_401, messageId: 1, text: "Batch A" })),
        signal,
      );
      await withinTest(monitor.waitForIdle(), signal);
      await withinTest(vi.advanceTimersByTimeAsync(1_000), signal);
      // Freeze the claim clock while each flushed turn finishes its real worker I/O.
      await withinTest(turnsDeferred[0].promise, signal);
      await withinTest(
        monitor.admit(forwardedTextUpdate({ updateId: 1_402, messageId: 2, text: "Batch B" })),
        signal,
      );
      await withinTest(monitor.waitForIdle(), signal);
      await withinTest(vi.advanceTimersByTimeAsync(1_000), signal);
      // A deferred head releases the sender key; B queues behind it in the session lane.
      await withinTest(turnsDeferred[1].promise, signal);
      await withinTest(vi.advanceTimersByTimeAsync(9_000), signal);
      const queue = openTelegramIngressQueue({ stateDir });
      expect(
        await withinTest(queue.listPending({ limit: "all" }), signal),
        "Batch B stalled behind A",
      ).toEqual([]);
      expect(
        (await withinTest(queue.listClaims(), signal)).map(({ id, attempts }) => ({
          id,
          attempts,
        })),
      ).toEqual([
        { id: telegramQueueEventId(1_401), attempts: 0 },
        { id: telegramQueueEventId(1_402), attempts: 0 },
      ]);
      releaseHead.resolve();
      await withinTest(monitor.waitForDeferredClaims(), signal);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Batch A",
        "Batch B",
      ]);
      await tombstones(1_401, 1_402);
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseHead.resolve();
      await monitor.stop();
    }
  });

  it("releases later albums when the album ahead of it stops making progress", async () => {
    const fetchStarted = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    const headFinished = createDeferred<void>();
    saveRemoteMedia.mockImplementationOnce(async () => {
      fetchStarted.resolve();
      // An uncooperative download must not retain the queue after its claim settles.
      await releaseFetch.promise;
      throw new Error("released stuck album download");
    });
    const { monitor } = await createMonitor({
      adoptionStallTimeoutMs: 1_000,
      onRuntimeError: () => headFinished.resolve(),
    });
    const followerDispatched = captureNextDownstreamTurn();
    useIngressTimers();
    monitor.start();
    try {
      await admitAlbum(monitor, "A", 1_101);
      await fetchStarted.promise;
      await admitAlbum(monitor, "B", 1_103);
      expect(downstreamTurns).not.toHaveBeenCalled();
      // Observe this attempt's disposition without the monitor reclaiming retryable rows.
      await monitor.pause();
      await vi.advanceTimersByTimeAsync(1_000);
      // B's dispatch needs worker I/O after A's claims settle; keep time frozen.
      await followerDispatched;
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledOnce();
      expect(downstreamTurns.mock.calls[0]?.[0].RawBody).toBe("Album B");
      const queue = openTelegramIngressQueue({ stateDir });
      await expectOnlyPending(queue, [
        {
          id: telegramQueueEventId(1_101),
          attempts: 1,
          lastError: expect.stringContaining("handler-timeout"),
        },
        {
          id: telegramQueueEventId(1_102),
          attempts: 1,
          lastError: expect.stringContaining("handler-timeout"),
        },
      ]);
      for (const updateId of [1_101, 1_102, 1_103, 1_104]) {
        await expect(
          queue.enqueue(telegramQueueEventId(updateId), {} as never),
        ).resolves.toMatchObject({
          kind: updateId < 1_103 ? "pending" : "completed",
        });
      }
    } finally {
      releaseFetch.resolve();
      await headFinished.promise;
      await monitor.stop();
    }
  });

  it("dispatches interleaved albums in first-member arrival order", async () => {
    const { monitor } = await createMonitor();
    useIngressTimers();
    monitor.start();
    try {
      for (const [index, name] of ["A", "B", "A"].entries()) {
        const update = photoUpdate({
          updateId: 1_301 + index,
          messageId: 1_301 + index,
          ...(index < 2 ? { caption: `Album ${name}` } : {}),
        });
        update.message.media_group_id = `album-${name}`;
        await monitor.admit(update);
        await monitor.waitForIdle();
        if (index < 2) {
          await vi.advanceTimersByTimeAsync(10);
        }
      }
      // B closes at 50 ms; A's last member moves its close to 60 ms.
      await vi.advanceTimersByTimeAsync(40);
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Album A",
        "Album B",
      ]);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.media?.length)).toEqual([2, 1]);
      await tombstones(1_301, 1_302, 1_303);
      expect(runtimeErrors).toEqual([]);
    } finally {
      await monitor.stop();
    }
  });

  it.each([
    {
      buffer: "album",
      delayMs: 40,
      first: photoUpdate({ updateId: 1_101, messageId: 1, caption: "Buffered context" }),
      second: photoUpdate({ updateId: 1_102, messageId: 2 }),
      media: [
        { path: "/tmp/photo-1.jpg", kind: "image" },
        { path: "/tmp/photo-2.jpg", kind: "image" },
      ],
    },
    {
      buffer: "forward",
      delayMs: 1_000,
      first: forwardedTextUpdate({ updateId: 1_201, messageId: 1, text: "Buffered context" }),
      second: forwardedPhotoUpdate({ updateId: 1_202, messageId: 2 }),
      media: [{ path: "/tmp/photo-1.jpg", kind: "image" }],
    },
  ])("holds the $buffer quiet flush while the next member is durably pending", async (testCase) => {
    const { monitor } = await createMonitor();
    vi.useFakeTimers({ toFake: ["performance"] });
    const quietTimers = holdTelegramMediaTimeouts(testCase.delayMs);
    const dispatched = captureNextDownstreamTurn();
    const queue = openTelegramIngressQueue({ stateDir });
    try {
      // Pause the pump, not durable admission: the next member has not reached the buffer.
      await spoolBehindPausedPump({ monitor, queue, stateDir, ...testCase });
      const held = createDeferred<void>();
      const scheduleHeldTimer = quietTimers.getMockImplementation();
      if (!scheduleHeldTimer) {
        throw new Error("Expected the held quiet-timer implementation");
      }
      quietTimers.mockImplementation((callback, delay, ...args) => {
        const timer = scheduleHeldTimer(callback, delay, ...args);
        if (delay === testCase.delayMs) {
          held.resolve();
        }
        return timer;
      });
      flushHeldQuietWindow(quietTimers, testCase.delayMs);
      expect(
        await Promise.race([held.promise.then(() => "held"), dispatched.then(() => "dispatched")]),
      ).toBe("held");
      quietTimers.mockImplementation(scheduleHeldTimer);
      expect(downstreamTurns).not.toHaveBeenCalled();

      monitor.start();
      await monitor.waitForIdle();
      flushHeldQuietWindow(quietTimers, testCase.delayMs);
      const turn = await dispatched;
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledOnce();
      expect(turn.Body).toContain("Buffered context");
      expect(turn).toMatchObject({ media: testCase.media });
      await tombstones(testCase.first.update_id, testCase.second.update_id);
    } finally {
      quietTimers.mockRestore();
    }
  });

  it.each([
    { readState: "pending", holdBeforeDeadline: false },
    { readState: "holding just before the deadline", holdBeforeDeadline: true },
  ])("flushes the album at its deadline with a $readState backlog read", async (testCase) => {
    const queue = openTelegramIngressQueue({ stateDir });
    const openQueue = vi.spyOn(ingressSpool, "openTelegramIngressQueue").mockReturnValue(queue);
    const { monitor } = await createMonitor();
    vi.useFakeTimers({ toFake: ["performance"] });
    const albumTimers = holdTelegramMediaTimeouts(40);
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const dispatched = captureNextDownstreamTurn();
    try {
      await spoolBehindPausedPump({
        monitor,
        queue,
        stateDir,
        first: photoUpdate({ updateId: 1_401, messageId: 1, caption: "Deadline photo album" }),
        second: photoUpdate({ updateId: 1_402, messageId: 2 }),
      });
      const listUnsettled = queue.listUnsettled?.bind(queue);
      if (!listUnsettled) {
        throw new Error("Expected the ingress queue's coherent backlog reader");
      }
      vi.spyOn(queue, "listUnsettled").mockImplementationOnce(async (options) => {
        const rows = await listUnsettled(options);
        readStarted.resolve();
        await releaseRead.promise;
        return rows;
      });
      const quietFlush = resolveFlushTimerForDelay(albumTimers, 40);
      if (!quietFlush) {
        throw new Error("Expected the buffered album's quiet timer");
      }
      albumTimers.mockRestore();
      vi.useFakeTimers({
        toFake: ["performance", "setTimeout", "clearTimeout"],
        shouldClearNativeTimers: true,
      });
      vi.advanceTimersByTime(40);
      quietFlush();
      await readStarted.promise;

      await vi.advanceTimersByTimeAsync(19_959);
      if (testCase.holdBeforeDeadline) {
        releaseRead.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(downstreamTurns).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      const turn = await dispatched;
      await monitor.waitForDeferredClaims();
      expect(turn.Body).toContain("Deadline photo album");
      expect(turn).toMatchObject({ media: [{ path: "/tmp/photo-1.jpg", kind: "image" }] });

      releaseRead.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(downstreamTurns).toHaveBeenCalledOnce();
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(1_402) },
      ]);
    } finally {
      releaseRead.resolve();
      albumTimers.mockRestore();
      openQueue.mockRestore();
    }
  });

  it("flushes an album while unrelated plain text is durably pending on the same lane", async () => {
    const { monitor } = await createMonitor();
    vi.useFakeTimers({ toFake: ["performance"] });
    const albumTimers = holdTelegramMediaTimeouts(40);
    const dispatched = captureNextDownstreamTurn();
    const queue = openTelegramIngressQueue({ stateDir });
    try {
      await spoolBehindPausedPump({
        monitor,
        queue,
        stateDir,
        first: photoUpdate({ updateId: 1_301, messageId: 1, caption: "Single photo album" }),
        second: textUpdate({ updateId: 1_302, messageId: 2, text: "Unrelated plain text" }),
      });

      flushHeldQuietWindow(albumTimers, 40);
      const turn = await dispatched;
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledOnce();
      expect(turn.Body).toContain("Single photo album");
      expect(turn).toMatchObject({ media: [{ path: "/tmp/photo-1.jpg", kind: "image" }] });
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(1_302) },
      ]);

      monitor.start();
      await monitor.waitForIdle();
      expect(downstreamTurns).toHaveBeenCalledTimes(2);
      expect(downstreamTurns.mock.calls[1]?.[0].Body).toContain("Unrelated plain text");
      await tombstones(1_301, 1_302);
    } finally {
      albumTimers.mockRestore();
    }
  });

  it.each(["commit", "rollback"] as const)(
    "joins a buffered adoption %s before monitor stop returns",
    async (phase) => {
      const operationStarted = createDeferred<void>();
      const releaseOperation = createDeferred<void>();
      const createGuard = messageDispatchDedupe.createTelegramMessageDispatchReplayGuard;
      const replay = interceptReplayGuard({
        commit: async (count, commit) => {
          if (phase === "commit" && count === 1) {
            operationStarted.resolve();
            await releaseOperation.promise;
            return await commit();
          }
          if (phase === "rollback" && count === 2) {
            await commit();
            throw new Error("synthetic second-key commit failure");
          }
          return await commit();
        },
        forget: async (forget) => {
          if (phase === "rollback") {
            operationStarted.resolve();
            await releaseOperation.promise;
          }
          return await forget();
        },
      });
      let stopping: Promise<void> | undefined;
      try {
        await spool(
          forwardedTextUpdate({ updateId: 901, messageId: 1, text: "First note" }),
          forwardedTextUpdate({ updateId: 902, messageId: 2, text: "Second note" }),
        );
        const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
        monitor.start();
        await operationStarted.promise;
        let stopped = false;
        stopping = monitor.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        expect(stopped).toBe(false);
      } finally {
        releaseOperation.resolve();
        await Promise.allSettled(replay.settlements);
        await stopping;
        replay.restore();
      }
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listClaims()).toEqual([]);
      if (phase === "commit") {
        await tombstones(901, 902);
      } else {
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: telegramQueueEventId(901), attempts: 0 },
          { id: telegramQueueEventId(902), attempts: 0 },
        ]);
      }
      const replayGuard = createGuard();
      for (const messageId of [1, 2]) {
        expect(
          await replayGuard.hasRecent({
            accountId: "default",
            botUserId: telegramBotInfoForTest.id,
            msg: forwardedTextUpdate({ updateId: 900 + messageId, messageId, text: "note" })
              .message,
          }),
        ).toBe(phase === "commit");
      }
    },
  );

  it("coalesces a forwarded burst whose members arrive in separate getUpdates responses", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    monitor.start();

    await monitor.admit(forwardedTextUpdate({ updateId: 301, messageId: 1, text: "First note" }));
    await monitor.waitForIdle();
    // Live Test Server bursts delivered the photo member up to 790 ms after the text.
    await vi.advanceTimersByTimeAsync(790);
    await monitor.admit(forwardedPhotoUpdate({ updateId: 302, messageId: 2 }));
    await monitor.waitForIdle();
    expect(downstreamTurns).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.media).toMatchObject([{ path: "/tmp/photo-1.jpg", kind: "image" }]);
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    await tombstones(301, 302);

    await monitor.stop();
    await telegramTransport.close();
  });

  it("keeps a forwarded burst pending when its deferred attachment download fails transiently", async () => {
    const downloadError = new MediaFetchError("http_error", "Telegram file download HTTP 502", {
      status: 502,
    });
    saveRemoteMedia.mockRejectedValueOnce(downloadError);
    await spool(
      forwardedTextUpdate({ updateId: 601, messageId: 1, text: "Forwarded context" }),
      forwardedPhotoUpdate({ updateId: 602, messageId: 2 }),
    );
    const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
    const forwardWindow = holdForwardWindow();

    try {
      monitor.start();
      await monitor.waitForIdle();
      // Both members are buffered before either attachment downloads.
      expect(saveRemoteMedia).not.toHaveBeenCalled();
      forwardWindow.flush();
      await monitor.waitForDeferredClaims();
    } finally {
      forwardWindow.restore();
      await monitor.stop();
    }

    expect(saveRemoteMedia).toHaveBeenCalledOnce();
    expect(downstreamTurns).not.toHaveBeenCalled();
    const queue = openTelegramIngressQueue({ stateDir });
    await expectOnlyPending(queue, [
      { id: telegramQueueEventId(601), attempts: 1, lastError: downloadError.message },
      { id: telegramQueueEventId(602), attempts: 1, lastError: downloadError.message },
    ]);
    // Released dispatch claims let the replay process both messages again.
    const replayGuard = messageDispatchDedupe.createTelegramMessageDispatchReplayGuard();
    for (const update of [
      forwardedTextUpdate({ updateId: 601, messageId: 1, text: "Forwarded context" }),
      forwardedPhotoUpdate({ updateId: 602, messageId: 2 }),
    ]) {
      expect(
        await replayGuard.hasRecent({
          accountId: "default",
          botUserId: telegramBotInfoForTest.id,
          msg: update.message,
        }),
      ).toBe(false);
    }
  });
});
