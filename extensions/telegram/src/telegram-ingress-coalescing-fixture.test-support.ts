import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  resetInboundDedupe,
  type GetReplyOptions,
  type MsgContext,
} from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, vi, type Mock } from "vitest";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import type { TelegramTransport } from "./fetch.js";
import * as messageDispatchDedupe from "./message-dispatch-dedupe.js";
import { setTelegramRuntime } from "./runtime.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  createBotApiTransport,
  createTelegramDeps,
  photoUpdate,
} from "./telegram-ingress-coalescing.test-support.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { openTelegramIngressQueue, telegramQueueEventId } from "./telegram-ingress-spool.js";

export const runtimeErrors: unknown[] = [];

const cfg = {
  messages: { inbound: { debounceMs: 0 } },
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
} as OpenClawConfig;

export function flushHeldQuietWindow(
  timers: ReturnType<typeof holdTelegramMediaTimeouts>,
  delayMs: number,
) {
  const flush = resolveFlushTimerForDelay(timers, delayMs);
  if (!flush) {
    throw new Error(`Expected the buffered update's ${delayMs} ms quiet timer`);
  }
  flush();
}

export async function assertSpoolTombstoned(params: { stateDir: string; updateIds: number[] }) {
  const queue = openTelegramIngressQueue(params);
  expect(await queue.listClaims()).toEqual([]);
  expect(await queue.listPending({ limit: "all" })).toEqual([]);
  expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
  // Every member tombstones independently, so a replayed update cannot re-enter.
  for (const updateId of params.updateIds) {
    await expect(queue.enqueue(telegramQueueEventId(updateId), {} as never)).resolves.toMatchObject(
      { kind: "completed" },
    );
  }
}

export function createDownstreamTurnFixture(
  downstreamTurns: Mock<
    (
      ctx: MsgContext,
      abortSignal?: AbortSignal,
      turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"],
    ) => Promise<{ queuedFinal: boolean; counts: { block: number; final: number; tool: number } }>
  >,
) {
  function captureNextDownstreamTurn() {
    const dispatched = createDeferred<MsgContext>();
    downstreamTurns.mockImplementationOnce(async (turn) => {
      dispatched.resolve(turn);
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    return dispatched.promise;
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

  async function assertAlbumTurnAndTombstones(params: {
    stateDir: string;
    updateIds: number[];
    monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
  }) {
    await params.monitor.waitForDeferredClaims();
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("Two photo album");
    expect(turn.media).toMatchObject([
      { path: "/tmp/photo-1.jpg", kind: "image" },
      { path: "/tmp/photo-2.jpg", kind: "image" },
    ]);
    await assertSpoolTombstoned(params);
  }

  function holdFirstDownstreamTurn() {
    const headDispatched = createDeferred<void>();
    const releaseHead = createDeferred<void>();
    const headFinished = createDeferred<void>();
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
    return { headDispatched, releaseHead, headFinished };
  }

  function holdDownstreamLane() {
    const releaseHead = createDeferred<void>();
    const turnsDeferred = [createDeferred<void>(), createDeferred<void>()];
    const turnsFinished: Promise<void>[] = [];
    // Session-lane stand-in: every turn defers, heartbeats, and adopts after the turn ahead.
    let laneTail: Promise<void> = releaseHead.promise;
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
    return { releaseHead, turnsDeferred, turnsFinished };
  }

  return {
    captureNextDownstreamTurn,
    awaitSingleDownstreamTurn,
    assertAlbumTurnAndTombstones,
    holdFirstDownstreamTurn,
    holdDownstreamLane,
  };
}

export function resetTelegramIngressRuntime() {
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
}

export type TelegramIngressMonitorOptions = {
  telegramTransport?: TelegramTransport;
  adoptionStallTimeoutMs?: number;
  pollIntervalMs?: number;
  onRuntimeError?: (error: unknown) => void;
};

export async function createIngressMonitor(
  stateDir: string,
  options: TelegramIngressMonitorOptions = {},
) {
  const telegramTransport = options.telegramTransport ?? createBotApiTransport();
  const abortController = new AbortController();
  const bot = await createTelegramBot({
    token: "tok",
    botInfo: telegramBotInfoForTest,
    config: cfg,
    telegramDeps: createTelegramDeps(stateDir, cfg),
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
    stateDir,
    bot,
    accountId: "default",
    botInfo: telegramBotInfoForTest,
    ...(options.adoptionStallTimeoutMs === undefined
      ? {}
      : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
    pollIntervalMs: options.pollIntervalMs ?? 10,
  });
  const resources = { monitor, telegramTransport, abortController, bot };
  return resources;
}

export async function admitAlbum(
  monitor: ReturnType<typeof createTelegramTransportIngressMonitor>,
  name: "A" | "B",
  firstId: number,
) {
  for (let index = 0; index < 2; index += 1) {
    const update = photoUpdate({
      updateId: firstId + index,
      messageId: firstId + index,
      ...(index === 0 ? { caption: `Album ${name}` } : {}),
    });
    update.message.media_group_id = `album-${name}`;
    await monitor.admit(update);
    await monitor.waitForIdle();
  }
  await vi.advanceTimersByTimeAsync(40);
}

export type TelegramIngressResources = Awaited<ReturnType<typeof createIngressMonitor>>;

export async function releaseIngressCase(
  activeResources: TelegramIngressResources[],
  activeTurns: Set<Promise<void>>,
  stateDir: string,
) {
  await Promise.all(
    activeResources.splice(0).map(async ({ monitor, telegramTransport, abortController }) => {
      abortController.abort(new Error("test cleanup"));
      await monitor.stop();
      await telegramTransport.close();
    }),
  );
  // Shutdown settles claims without waiting for turns still recording their session;
  // a late write would bind this case's agent database to the next case's state.
  while (activeTurns.size > 0) {
    await Promise.all(activeTurns);
  }
  // Session maintenance outlives its writer by design; retire it with this case's databases.
  await closeOpenClawAgentDatabasesAsync(stateDir);
}

export function useIngressTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
}

/** Intercepts durable replay settlement while preserving the real claim and rollback operations. */
export function interceptReplayGuard(hooks: {
  commit: (count: number, commit: () => Promise<boolean>) => Promise<boolean>;
  forget?: (forget: () => Promise<boolean>) => Promise<boolean>;
}) {
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
      const forget = hooks.forget;
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
                return await hooks.commit(commitCount, () => claim.handle.commit(commitOptions));
              },
            },
          };
        },
        ...(forget
          ? {
              forget: async (...args: Parameters<typeof guard.forget>) =>
                await forget(() => guard.forget(...args)),
            }
          : {}),
      };
    });
  return {
    settlements,
    restore: () => {
      commitSpy.mockRestore();
      guardSpy.mockRestore();
    },
  };
}
