// Telegram ingress coalescing regression: durable queue → core drain → grammY → inbound buffer.
// Both Telegram inbound buffers (album, forward-burst debounce) defer their spooled
// participant the same way, so both depend on deferredLaneOccupancy="release" to admit
// later same-lane members. Cover them together — a lane regression breaks both at once.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type { TelegramTransport } from "./fetch.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  photoUpdate,
  forwardedTextUpdate,
  textUpdate,
} from "./telegram-ingress-coalescing.test-support.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(async (_ctx: MsgContext, _abortSignal?: AbortSignal) => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  })),
);
const runtimeErrors: unknown[] = [];

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
        return await downstreamTurns(dispatchParams.ctx, dispatchParams.replyOptions?.abortSignal);
      }),
  };
});

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: async (params: { filePathHint?: string }) => ({
      id: path.basename(params.filePathHint ?? "photo"),
      path: `/tmp/${path.basename(params.filePathHint ?? "photo.jpg")}`,
      size: 4,
      contentType: "image/jpeg",
    }),
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

const { createTelegramBot } = await import("./bot.js");
const { resetInboundDedupe } = await import("openclaw/plugin-sdk/reply-runtime");
const { createTelegramTransportIngressMonitor } =
  await import("./telegram-ingress-drain-factory.js");
const { setTelegramRuntime } = await import("./runtime.js");
const { resetTelegramAccountThrottlersForTest } = await import("./runtime.test-support.js");
const { openTelegramIngressQueue, telegramQueueEventId } =
  await import("./telegram-ingress-spool.js");
const { writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.test-support.js");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const processingOutcome = await import("./bot-processing-outcome.js");

const cfg = {
  messages: { inbound: { debounceMs: 0 } },
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
} as OpenClawConfig;

function createBotApiTransport() {
  let getFileCall = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url.includes("/getFile")) {
      getFileCall += 1;
      return Response.json({
        ok: true,
        result: {
          file_id: `photo-${getFileCall}`,
          file_unique_id: `unique-${getFileCall}`,
          file_size: 4,
          file_path: `photos/photo-${getFileCall}.jpg`,
        },
      });
    }
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
}

function createTelegramDeps(stateDir: string): TelegramBotDeps {
  return {
    getRuntimeConfig: () => cfg,
    resolveStorePath: (storePath?: string) => storePath ?? path.join(stateDir, "sessions.json"),
    readChannelAllowFromStore: async () => [],
    upsertChannelPairingRequest: async () => ({ code: "PAIRCODE", created: true }),
    enqueueRoutedSystemEvent: () => false,
    dispatchReplyWithBufferedBlockDispatcher: async () => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
    buildModelsProviderData: async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-test" },
      modelNames: new Map<string, string>(),
      modelCatalog: [],
    }),
    listSkillCommandsForAgents: () => [],
    wasSentByBot: () => false,
  } as TelegramBotDeps;
}

/** Both members must land in one turn; a second turn is the split this file guards. */
async function awaitSingleDownstreamTurn(): Promise<MsgContext & Record<string, unknown>> {
  await vi.waitFor(
    () => {
      expect(downstreamTurns, runtimeErrors.map(String).join("\n")).toHaveBeenCalledTimes(1);
    },
    { timeout: 5_000, interval: 5 },
  );
  return downstreamTurns.mock.calls[0]?.[0] as MsgContext & Record<string, unknown>;
}

async function assertSpoolTombstoned(params: { spoolDir: string; updateIds: number[] }) {
  const queue = openTelegramIngressQueue(params.spoolDir);
  expect(await queue.listClaims()).toEqual([]);
  expect(await queue.listPending({ limit: "all" })).toEqual([]);
  // Every member tombstones independently, so a replayed update cannot re-enter.
  for (const updateId of params.updateIds) {
    await expect(queue.enqueue(telegramQueueEventId(updateId), {} as never)).resolves.toMatchObject(
      { kind: "completed" },
    );
  }
}

async function assertAlbumTurnAndTombstones(params: {
  spoolDir: string;
  updateIds: number[];
  monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
}) {
  const turn = await awaitSingleDownstreamTurn();
  expect(turn.Body).toContain("Two photo album");
  expect(turn.media).toMatchObject([
    { path: "/tmp/photo-1.jpg", kind: "image" },
    { path: "/tmp/photo-2.jpg", kind: "image" },
  ]);
  await params.monitor.waitForDeferredClaims();
  await assertSpoolTombstoned(params);
}

describe("Telegram durable ingress coalescing", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let spoolDir: string;
  let activeResources: Array<{
    monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
    telegramTransport: TelegramTransport;
    abortController: AbortController;
  }>;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-album-ingress-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
    activeResources = [];
    runtimeErrors.length = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    resetInboundDedupe();
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramAccountThrottlersForTest();
    setTelegramRuntime({
      state: {
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
        // Command-menu locale ledger reads the keyed store during hydration;
        // an absent store degrades with a warning that breaks watchdog asserts.
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    } as TelegramRuntime);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      activeResources.map(async ({ monitor, telegramTransport, abortController }) => {
        abortController.abort(new Error("test cleanup"));
        await monitor.stop();
        await telegramTransport.close();
      }),
    );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function createMonitor(
    options: {
      telegramTransport?: TelegramTransport;
      adoptionStallTimeoutMs?: number;
      onRuntimeError?: (error: unknown) => void;
    } = {},
  ) {
    const telegramTransport = options.telegramTransport ?? createBotApiTransport();
    const abortController = new AbortController();
    const bot = await createTelegramBot({
      token: "tok",
      botInfo: telegramBotInfoForTest,
      config: cfg,
      telegramDeps: createTelegramDeps(stateDir),
      telegramTransport,
      fetchAbortSignal: abortController.signal,
      mediaAbortSignal: abortController.signal,
      testTimings: { mediaGroupFlushMs: 40, textFragmentGapMs: 20 },
      runtime: {
        log: () => {},
        error:
          options.onRuntimeError ??
          ((error) => {
            runtimeErrors.push(error);
            throw error instanceof Error ? error : new Error(String(error));
          }),
        getRuntimeConfig: () => cfg,
        exit: () => {
          throw new Error("unexpected runtime exit");
        },
      } as RuntimeEnv,
    });
    const monitor = createTelegramTransportIngressMonitor({
      spoolDir,
      bot,
      accountId: "default",
      botInfo: telegramBotInfoForTest,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      pollIntervalMs: 10,
    });
    const resources = { monitor, telegramTransport, abortController };
    activeResources.push(resources);
    return resources;
  }

  it("coalesces album members admitted a few milliseconds apart", async () => {
    const albumTimers = holdTelegramMediaTimeouts(40);
    const { monitor, telegramTransport } = await createMonitor();
    const first = photoUpdate({ updateId: 101, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 102, messageId: 2 });
    monitor.start();

    try {
      await monitor.admit(first);
      await monitor.waitForIdle();
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      await monitor.admit(second);
      await monitor.waitForIdle();
      const flush = resolveFlushTimerForDelay(albumTimers, 40);
      if (!flush) {
        throw new Error("Expected the admitted album's flush timer");
      }
      flush();
      await assertAlbumTurnAndTombstones({ spoolDir, updateIds: [101, 102], monitor });
    } finally {
      albumTimers.mockRestore();
      await monitor.stop();
      await telegramTransport.close();
    }
  });

  it("coalesces an album replayed from a durable restart backlog", async () => {
    const first = photoUpdate({ updateId: 201, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 202, messageId: 2 });
    await writeTelegramSpooledUpdate({ spoolDir, update: first });
    await writeTelegramSpooledUpdate({ spoolDir, update: second });
    const { monitor, telegramTransport } = await createMonitor();

    monitor.start();
    await assertAlbumTurnAndTombstones({ spoolDir, updateIds: [201, 202], monitor });

    await monitor.stop();
    await telegramTransport.close();
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
          spoolDir,
          update: forwardedTextUpdate({ updateId: 901, messageId: 1, text: "First note" }),
        });
        await writeTelegramSpooledUpdate({
          spoolDir,
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
      const queue = openTelegramIngressQueue(spoolDir);
      expect(await queue.listClaims()).toEqual([]);
      if (phase === "commit") {
        await assertSpoolTombstoned({ spoolDir, updateIds: [901, 902] });
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
      const queue = openTelegramIngressQueue(spoolDir);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: telegramQueueEventId(903), attempts: 0 },
      ]);
    } finally {
      participantSpy.mockRestore();
    }
  });

  it("coalesces a forwarded burst admitted a few milliseconds apart", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    monitor.start();

    await monitor.admit(forwardedTextUpdate({ updateId: 301, messageId: 1, text: "First note" }));
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await monitor.admit(forwardedTextUpdate({ updateId: 302, messageId: 2, text: "Second note" }));

    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.Body).toContain("Second note");
    await monitor.waitForDeferredClaims();
    await assertSpoolTombstoned({ spoolDir, updateIds: [301, 302] });

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
      await vi.advanceTimersByTimeAsync(20);
      if (index === 19) {
        // Hold the 400 ms clock boundary while the flushed turn finishes real I/O.
        await firstDispatch.promise;
        expect(downstreamTurns.mock.calls.length).toBeGreaterThan(0);
      }
    }

    await vi.advanceTimersByTimeAsync(80);

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
    await assertSpoolTombstoned({ spoolDir, updateIds });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("coalesces a forwarded burst replayed from a durable restart backlog", async () => {
    await writeTelegramSpooledUpdate({
      spoolDir,
      update: forwardedTextUpdate({ updateId: 401, messageId: 1, text: "First note" }),
    });
    await writeTelegramSpooledUpdate({
      spoolDir,
      update: forwardedTextUpdate({ updateId: 402, messageId: 2, text: "Second note" }),
    });
    const { monitor, telegramTransport } = await createMonitor();

    monitor.start();
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.Body).toContain("Second note");
    await monitor.waitForDeferredClaims();
    await assertSpoolTombstoned({ spoolDir, updateIds: [401, 402] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("keeps a text update pending when shutdown aborts the turn before adoption", async () => {
    const update = textUpdate({
      updateId: 901,
      messageId: 1,
      text: "interrupted by restart",
    });
    const eventId = telegramQueueEventId(update.update_id);
    await writeTelegramSpooledUpdate({ spoolDir, update });
    const queue = openTelegramIngressQueue(spoolDir);
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
    await writeTelegramSpooledUpdate({ spoolDir, update });
    const queue = openTelegramIngressQueue(spoolDir);
    expect(await queue.claim(eventId, { ownerId: "999:1:dead-owner" })).not.toBeNull();
    downstreamTurns.mockRejectedValueOnce(sessionError);
    const runtimeError = vi.fn();
    const { monitor, telegramTransport } = await createMonitor({
      adoptionStallTimeoutMs: 5_000,
      onRuntimeError: runtimeError,
    });

    monitor.start();
    await vi.waitFor(
      async () => {
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 2, lastError: sessionError.message },
        ]);
      },
      { timeout: 2_000, interval: 5 },
    );
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
    await writeTelegramSpooledUpdate({ spoolDir, update: poison });
    await writeTelegramSpooledUpdate({ spoolDir, update: after });
    const queue = openTelegramIngressQueue(spoolDir);
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
