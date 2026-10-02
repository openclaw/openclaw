// Telegram ingress coalescing regression: durable queue → core drain → grammY → inbound buffer.
// Both Telegram inbound buffers (album, forward-burst debounce) defer their spooled
// participant the same way, so both depend on deferredLaneOccupancy="release" to admit
// later same-lane members. Cover them together — a lane regression breaks both at once.
import path from "node:path";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
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
  createBotApiTransport,
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
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      await runTelegramChannelInboundEventWithHarness(actual, params, async (dispatchParams) => {
        return await downstreamTurns(
          dispatchParams.ctx,
          dispatchParams.replyOptions?.abortSignal,
          dispatchParams.replyOptions?.turnAdoptionLifecycle,
        );
      }),
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    saveRemoteMedia,
  };
});

vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadPreparedModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
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
  createDownstreamTurnAssertions,
  createIngressMonitor,
  flushHeldQuietWindow,
  resetTelegramIngressRuntime,
  runtimeErrors,
  stopIngressResources,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");
const { captureNextDownstreamTurn, awaitSingleDownstreamTurn, assertAlbumTurnAndTombstones } =
  createDownstreamTurnAssertions(downstreamTurns);

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
    await stopIngressResources(activeResources);
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

  it("coalesces album members admitted across separate drain passes", async () => {
    const albumTimers = holdTelegramMediaTimeouts(40);
    const { monitor, telegramTransport } = await createMonitor();
    const first = photoUpdate({ updateId: 101, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 102, messageId: 2 });
    monitor.start();

    try {
      await monitor.admit(first);
      await monitor.waitForIdle();
      await monitor.admit(second);
      await monitor.waitForIdle();
      const flush = resolveFlushTimerForDelay(albumTimers, 40);
      if (!flush) {
        throw new Error("Expected the admitted album's flush timer");
      }
      flush();
      await assertAlbumTurnAndTombstones({ stateDir, updateIds: [101, 102], monitor });
    } finally {
      albumTimers.mockRestore();
      await monitor.stop();
      await telegramTransport.close();
    }
  });

  it("coalesces an album replayed from a durable restart backlog", async () => {
    const first = photoUpdate({ updateId: 201, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 202, messageId: 2 });
    await writeTelegramSpooledUpdate({ stateDir, update: first });
    await writeTelegramSpooledUpdate({ stateDir, update: second });
    const { monitor, telegramTransport } = await createMonitor();
    const albumTimers = holdTelegramMediaTimeouts(40);

    try {
      monitor.start();
      // Real state-worker admission must finish before the controlled album deadline.
      await monitor.waitForIdle();
      const queue = openTelegramIngressQueue({ stateDir });
      expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual([
        telegramQueueEventId(201),
        telegramQueueEventId(202),
      ]);
      expect(downstreamTurns).not.toHaveBeenCalled();
      const flush = resolveFlushTimerForDelay(albumTimers, 40);
      if (!flush) {
        throw new Error("Expected the replayed album's flush timer");
      }
      flush();
      await assertAlbumTurnAndTombstones({ stateDir, updateIds: [201, 202], monitor });
    } finally {
      albumTimers.mockRestore();
      await monitor.stop();
      await telegramTransport.close();
    }
  });

  it("keeps a later album alive and ordered behind a slowly adopting album", async () => {
    const headDispatched = createDeferred<void>();
    const releaseHead = createDeferred<void>();
    const headFinished = createDeferred<void>();
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 1_000 });
    downstreamTurns.mockImplementation(async (_ctx, abortSignal, lifecycle) => {
      if (downstreamTurns.mock.calls.length === 1) {
        if (!lifecycle?.deferredHeartbeatIntervalMs) {
          throw new Error("Expected the deferred turn's heartbeat cadence");
        }
        lifecycle.onDeferred?.();
        const heartbeat = setInterval(
          () => lifecycle.onDeferredHeartbeat?.(),
          lifecycle.deferredHeartbeatIntervalMs,
        );
        headDispatched.resolve();
        try {
          await releaseHead.promise;
          if (!abortSignal?.aborted) {
            await lifecycle.onAdopted();
          }
        } finally {
          clearInterval(heartbeat);
          headFinished.resolve();
        }
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    monitor.start();
    try {
      await admitAlbum(monitor, "A", 1_001);
      // Freeze the claim clock while dispatch finishes its real worker I/O.
      await headDispatched.promise;
      await admitAlbum(monitor, "B", 1_003);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(downstreamTurns, "Album B must wait for album A's adoption").toHaveBeenCalledOnce();
      releaseHead.resolve();
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledTimes(2);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Album A",
        "Album B",
      ]);
      await assertSpoolTombstoned({ stateDir, updateIds: [1_001, 1_002, 1_003, 1_004] });
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseHead.resolve();
      await headFinished.promise;
      await monitor.stop();
    }
  });

  it("keeps a later same-sender forward batch alive behind a deferred batch", async () => {
    const releaseHead = createDeferred<void>();
    const turnsDeferred = [createDeferred<void>(), createDeferred<void>()];
    const turnsFinished: Promise<void>[] = [];
    // Session-lane stand-in: every turn defers, heartbeats, and adopts after the turn ahead.
    let laneTail: Promise<void> = releaseHead.promise;
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 3_000 });
    downstreamTurns.mockImplementation(async (_ctx, abortSignal, lifecycle) => {
      if (!lifecycle?.deferredHeartbeatIntervalMs) {
        throw new Error("Expected the deferred turn's heartbeat cadence");
      }
      const ahead = laneTail;
      const finished = createDeferred<void>();
      laneTail = finished.promise;
      const turnIndex = turnsFinished.push(finished.promise) - 1;
      lifecycle.onDeferred?.();
      const heartbeat = setInterval(
        () => lifecycle.onDeferredHeartbeat?.(),
        lifecycle.deferredHeartbeatIntervalMs,
      );
      turnsDeferred[turnIndex]?.resolve();
      try {
        await ahead;
        if (!abortSignal?.aborted) {
          await lifecycle.onAdopted();
        }
      } finally {
        clearInterval(heartbeat);
        finished.resolve();
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    monitor.start();
    try {
      await monitor.admit(forwardedTextUpdate({ updateId: 1_401, messageId: 1, text: "Batch A" }));
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(1_000);
      // Freeze the claim clock while each flushed turn finishes its real worker I/O.
      await turnsDeferred[0]?.promise;
      await monitor.admit(forwardedTextUpdate({ updateId: 1_402, messageId: 2, text: "Batch B" }));
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(1_000);
      // A deferred head releases the sender key; B queues behind it in the session lane.
      await turnsDeferred[1]?.promise;
      await vi.advanceTimersByTimeAsync(9_000);
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listPending({ limit: "all" }), "Batch B stalled behind A").toEqual([]);
      expect((await queue.listClaims()).map(({ id, attempts }) => ({ id, attempts }))).toEqual([
        { id: telegramQueueEventId(1_401), attempts: 0 },
        { id: telegramQueueEventId(1_402), attempts: 0 },
      ]);
      releaseHead.resolve();
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Batch A",
        "Batch B",
      ]);
      await assertSpoolTombstoned({ stateDir, updateIds: [1_401, 1_402] });
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseHead.resolve();
      await Promise.all(turnsFinished);
      await monitor.stop();
    }
  });

  it("releases later albums when the album ahead of it stops making progress", async () => {
    const fetchStarted = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    const headFinished = createDeferred<void>();
    const followerDispatched = createDeferred<void>();
    const transport = createBotApiTransport();
    let fetchHeld = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("/getFile") && !fetchHeld) {
        fetchHeld = true;
        fetchStarted.resolve();
        // Deliberately ignore init.signal: claim settlement must release the queue.
        await releaseFetch.promise;
        throw new Error("released stuck album download");
      }
      return await transport.fetch(input, init);
    };
    const { monitor } = await createMonitor({
      adoptionStallTimeoutMs: 1_000,
      telegramTransport: { ...transport, fetch: fetchImpl, sourceFetch: fetchImpl },
      onRuntimeError: () => headFinished.resolve(),
    });
    downstreamTurns.mockImplementation(async () => {
      followerDispatched.resolve();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
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
      await followerDispatched.promise;
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledOnce();
      expect(downstreamTurns.mock.calls[0]?.[0].RawBody).toBe("Album B");
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
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

  it("keeps every album member claimed while durable adoption commit is held", async () => {
    const commitStarted = createDeferred<void>();
    const releaseCommit = createDeferred<void>();
    const createGuard = messageDispatchDedupe.createTelegramMessageDispatchReplayGuard;
    const commitReplay = messageDispatchDedupe.commitTelegramMessageDispatchReplay;
    const settlements: Promise<void>[] = [];
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockImplementation((params) => {
        const settlement = commitReplay(params);
        settlements.push(settlement);
        return settlement;
      });
    let commitCount = 0;
    const guardSpy = vi
      .spyOn(messageDispatchDedupe, "createTelegramMessageDispatchReplayGuard")
      .mockImplementation((options) => {
        const guard = createGuard(options);
        return {
          ...guard,
          claim: async (...args) => {
            const claim = await guard.claim(...args);
            if (claim.kind !== "claimed") {
              return claim;
            }
            return {
              ...claim,
              handle: {
                ...claim.handle,
                commit: async (commitOptions) => {
                  commitCount += 1;
                  if (commitCount === 1) {
                    commitStarted.resolve();
                    await releaseCommit.promise;
                  }
                  return await claim.handle.commit(commitOptions);
                },
              },
            };
          },
        };
      });
    const { monitor } = await createMonitor({
      adoptionStallTimeoutMs: 1_000,
      onRuntimeError: (error) => runtimeErrors.push(error),
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    monitor.start();
    try {
      await admitAlbum(monitor, "A", 1_201);
      // The normal downstream return starts durable finalization without turn heartbeats.
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      releaseCommit.resolve();
      await Promise.all(settlements);
      await monitor.waitForDeferredClaims();
      expect(downstreamTurns).toHaveBeenCalledOnce();
      await assertSpoolTombstoned({ stateDir, updateIds: [1_201, 1_202] });
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseCommit.resolve();
      await Promise.allSettled(settlements);
      await monitor.stop();
      commitSpy.mockRestore();
      guardSpy.mockRestore();
    }
  });

  it("dispatches interleaved albums in first-member arrival order", async () => {
    const { monitor } = await createMonitor();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
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
      expect(downstreamTurns).toHaveBeenCalledTimes(2);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Album A",
        "Album B",
      ]);
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.media?.length)).toEqual([2, 1]);
      await assertSpoolTombstoned({ stateDir, updateIds: [1_301, 1_302, 1_303] });
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
      monitor.start();
      await monitor.admit(testCase.first);
      await monitor.waitForIdle();
      await monitor.pause();

      // Pause the pump, not durable admission: the next member has not reached the buffer.
      await writeTelegramSpooledUpdate({ stateDir, update: testCase.second });
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(testCase.second.update_id) },
      ]);
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
      await assertSpoolTombstoned({
        stateDir,
        updateIds: [testCase.first.update_id, testCase.second.update_id],
      });
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
      monitor.start();
      await monitor.admit(
        photoUpdate({ updateId: 1_401, messageId: 1, caption: "Deadline photo album" }),
      );
      await monitor.waitForIdle();
      await monitor.pause();
      await writeTelegramSpooledUpdate({
        stateDir,
        update: photoUpdate({ updateId: 1_402, messageId: 2 }),
      });
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(1_402) },
      ]);
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
      monitor.start();
      await monitor.admit(
        photoUpdate({ updateId: 1_301, messageId: 1, caption: "Single photo album" }),
      );
      await monitor.waitForIdle();
      await monitor.pause();
      await writeTelegramSpooledUpdate({
        stateDir,
        update: textUpdate({ updateId: 1_302, messageId: 2, text: "Unrelated plain text" }),
      });
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(1_302) },
      ]);

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
      await assertSpoolTombstoned({ stateDir, updateIds: [1_301, 1_302] });
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
      const commitReplay = messageDispatchDedupe.commitTelegramMessageDispatchReplay;
      const settlements: Promise<void>[] = [];
      const commitSpy = vi
        .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
        .mockImplementation((params) => {
          const settlement = commitReplay(params);
          settlements.push(settlement);
          return settlement;
        });
      let commitCount = 0;
      const guardSpy = vi
        .spyOn(messageDispatchDedupe, "createTelegramMessageDispatchReplayGuard")
        .mockImplementation((options) => {
          const guard = createGuard(options);
          return {
            ...guard,
            claim: async (...args) => {
              const claim = await guard.claim(...args);
              if (claim.kind !== "claimed") {
                return claim;
              }
              return {
                ...claim,
                handle: {
                  ...claim.handle,
                  commit: async (commitOptions) => {
                    commitCount += 1;
                    if (phase === "commit" && commitCount === 1) {
                      operationStarted.resolve();
                      await releaseOperation.promise;
                      return await claim.handle.commit(commitOptions);
                    }
                    if (phase === "rollback" && commitCount === 2) {
                      await claim.handle.commit(commitOptions);
                      throw new Error("synthetic second-key commit failure");
                    }
                    return await claim.handle.commit(commitOptions);
                  },
                },
              };
            },
            forget: async (...args) => {
              if (phase === "rollback") {
                operationStarted.resolve();
                await releaseOperation.promise;
              }
              return await guard.forget(...args);
            },
          };
        });
      let stopping: Promise<void> | undefined;
      try {
        await writeTelegramSpooledUpdate({
          stateDir,
          update: forwardedTextUpdate({ updateId: 901, messageId: 1, text: "First note" }),
        });
        await writeTelegramSpooledUpdate({
          stateDir,
          update: forwardedTextUpdate({ updateId: 902, messageId: 2, text: "Second note" }),
        });
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
        await Promise.allSettled(settlements);
        await stopping;
        commitSpy.mockRestore();
        guardSpy.mockRestore();
      }
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listClaims()).toEqual([]);
      if (phase === "commit") {
        await assertSpoolTombstoned({ stateDir, updateIds: [901, 902] });
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

  it("settles a never-adopted buffered participant when monitor stop aborts its owner", async () => {
    const buffered = createDeferred<void>();
    const createParticipant = processingOutcome.createTelegramSpooledReplayParticipant;
    const participantSpy = vi
      .spyOn(processingOutcome, "createTelegramSpooledReplayParticipant")
      .mockImplementation((key) => {
        const participant = createParticipant(key);
        buffered.resolve();
        return participant;
      });
    try {
      const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
      monitor.start();
      await monitor.admit(textUpdate({ updateId: 903, messageId: 3, text: "long ".repeat(810) }));
      await buffered.promise;
      await monitor.stop();
      expect(downstreamTurns).not.toHaveBeenCalled();
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(903), attempts: 0 },
      ]);
    } finally {
      participantSpy.mockRestore();
    }
  });

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
    await vi.advanceTimersByTimeAsync(1_000);

    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.media).toMatchObject([{ path: "/tmp/photo-1.jpg", kind: "image" }]);
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    await assertSpoolTombstoned({ stateDir, updateIds: [301, 302] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("dispatches sustained forwarded messages before their ingress stream falls quiet", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    const messageCount = 24;
    const updateIds = Array.from({ length: messageCount }, (_, index) => 501 + index);
    const firstDispatch = createDeferred<void>();
    downstreamTurns.mockImplementationOnce(async () => {
      firstDispatch.resolve();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    monitor.start();

    for (let index = 0; index < messageCount; index += 1) {
      await monitor.admit(
        forwardedTextUpdate({
          updateId: 501 + index,
          messageId: index + 1,
          text: `sustained-forward-${String(index).padStart(2, "0")}`,
        }),
      );
      // Durable admission can precede buffer entry while the handler hydrates state.
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(250);
      if (index === 19) {
        // Hold the 5 s clock boundary while the flushed turn finishes real I/O.
        await firstDispatch.promise;
        expect(downstreamTurns.mock.calls.length).toBeGreaterThan(0);
      }
    }

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(
      () => {
        const deliveredMessageIds = downstreamTurns.mock.calls.flatMap(([context]) => {
          const turn = context as MsgContext;
          return Array.from(
            (turn.BodyForAgent ?? turn.Body ?? "").matchAll(/sustained-forward-(\d{2})/g),
            (match) => match[1],
          );
        });
        expect(deliveredMessageIds).toEqual(
          Array.from({ length: messageCount }, (_, index) => String(index).padStart(2, "0")),
        );
      },
      { timeout: 5_000, interval: 5 },
    );
    await monitor.waitForDeferredClaims();
    await assertSpoolTombstoned({ stateDir, updateIds });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("coalesces a forwarded burst replayed from a durable restart backlog", async () => {
    await writeTelegramSpooledUpdate({
      stateDir,
      update: forwardedTextUpdate({ updateId: 401, messageId: 1, text: "First note" }),
    });
    await writeTelegramSpooledUpdate({
      stateDir,
      update: forwardedTextUpdate({ updateId: 402, messageId: 2, text: "Second note" }),
    });
    const { monitor, telegramTransport } = await createMonitor();
    const forwardWindow = holdForwardWindow();

    try {
      monitor.start();
      await monitor.waitForIdle();
      forwardWindow.flush();
    } finally {
      forwardWindow.restore();
    }
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.Body).toContain("Second note");
    await monitor.waitForDeferredClaims();
    await assertSpoolTombstoned({ stateDir, updateIds: [401, 402] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("keeps a forwarded burst pending when its deferred attachment download fails transiently", async () => {
    const downloadError = new MediaFetchError("http_error", "Telegram file download HTTP 502", {
      status: 502,
    });
    saveRemoteMedia.mockRejectedValueOnce(downloadError);
    await writeTelegramSpooledUpdate({
      stateDir,
      update: forwardedTextUpdate({ updateId: 601, messageId: 1, text: "Forwarded context" }),
    });
    await writeTelegramSpooledUpdate({
      stateDir,
      update: forwardedPhotoUpdate({ updateId: 602, messageId: 2 }),
    });
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
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
    expect(await queue.listPending({ limit: "all" })).toMatchObject([
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

  it("keeps a text update pending when shutdown aborts the turn before adoption", async () => {
    const update = textUpdate({
      updateId: 901,
      messageId: 1,
      text: "interrupted by restart",
    });
    const eventId = telegramQueueEventId(update.update_id);
    await writeTelegramSpooledUpdate({ stateDir, update });
    const queue = openTelegramIngressQueue({ stateDir });
    downstreamTurns.mockImplementationOnce(async (_ctx, abortSignal) => {
      if (!abortSignal) {
        throw new Error("Expected the turn's abort signal");
      }
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const { monitor, telegramTransport } = await createMonitor();

    monitor.start();
    await awaitSingleDownstreamTurn();
    await monitor.stop();
    await telegramTransport.close();

    await vi.waitFor(async () => {
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: eventId, attempts: 0 },
      ]);
    });
    expect(
      (
        await queue.enqueue(eventId, {
          version: 1,
          updateId: update.update_id,
          receivedAt: Date.now(),
          update,
        })
      ).kind,
    ).not.toBe("completed");
  });

  it("releases a stale forwarded claim once when custom debounce dispatch fails", async () => {
    const update = forwardedTextUpdate({
      updateId: 701,
      messageId: 1,
      text: "recovered forward",
    });
    const eventId = telegramQueueEventId(update.update_id);
    const sessionError = new Error("Session changed while starting work. Retry.");
    await writeTelegramSpooledUpdate({ stateDir, update });
    const queue = openTelegramIngressQueue({ stateDir });
    expect(await queue.claim(eventId, { ownerId: "999:1:dead-owner" })).not.toBeNull();
    downstreamTurns.mockRejectedValueOnce(sessionError);
    const runtimeError = vi.fn();
    const { monitor, telegramTransport } = await createMonitor({
      adoptionStallTimeoutMs: 5_000,
      onRuntimeError: runtimeError,
    });
    const forwardWindow = holdForwardWindow();

    try {
      monitor.start();
      await monitor.waitForIdle();
      forwardWindow.flush();
    } finally {
      forwardWindow.restore();
    }
    await monitor.waitForDeferredClaims();
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
    expect(await queue.listPending({ limit: "all" })).toMatchObject([
      { id: eventId, attempts: 2, lastError: sessionError.message },
    ]);
    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(runtimeError).toHaveBeenCalledOnce();

    await monitor.stop();
    await telegramTransport.close();
  });

  it("bounds repeated session-start conflicts and drains the next Telegram update", async () => {
    const poison = textUpdate({ updateId: 801, messageId: 1, text: "poison" });
    const after = textUpdate({ updateId: 802, messageId: 2, text: "after" });
    const poisonId = telegramQueueEventId(poison.update_id);
    const sessionError = Object.assign(
      new Error('Session "agent:main:telegram:direct:111" changed while starting work. Retry.'),
      { code: "SESSION_WORK_START_CHANGED" },
    );
    downstreamTurns.mockImplementation(async (turn) => {
      if ((turn.BodyForAgent ?? turn.Body ?? "").includes("poison")) {
        throw sessionError;
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    await writeTelegramSpooledUpdate({ stateDir, update: poison });
    await writeTelegramSpooledUpdate({ stateDir, update: after });
    const queue = openTelegramIngressQueue({ stateDir });
    for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const claim = await queue.claim(poisonId, { ownerId: `proof:${attempt}` });
      if (!claim) {
        throw new Error(`Expected setup claim ${attempt}`);
      }
      await queue.release(claim, {
        lastError: sessionError.message,
        releasedAt: Date.now() - 60 * 60 * 1_000,
      });
    }
    const runtimeError = vi.fn();
    const { monitor, telegramTransport } = await createMonitor({ onRuntimeError: runtimeError });

    monitor.start();
    await monitor.waitForIdle();
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([
      expect.objectContaining({ id: poisonId, reason: "session-start-conflict-retry-limit" }),
    ]);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(
      downstreamTurns.mock.calls.some(([turn]) =>
        (turn.BodyForAgent ?? turn.Body ?? "").includes("after"),
      ),
    ).toBe(true);

    await monitor.stop();
    await telegramTransport.close();
  });
});
