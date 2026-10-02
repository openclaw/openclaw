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
import { expect, vi, type Mock } from "vitest";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import type { TelegramTransport } from "./fetch.js";
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

export function createDownstreamTurnAssertions(
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

  return { captureNextDownstreamTurn, awaitSingleDownstreamTurn, assertAlbumTurnAndTombstones };
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
    pollIntervalMs: 10,
  });
  const resources = { monitor, telegramTransport, abortController };
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

export async function stopIngressResources(activeResources: TelegramIngressResources[]) {
  await Promise.all(
    activeResources.map(async ({ monitor, telegramTransport, abortController }) => {
      abortController.abort(new Error("test cleanup"));
      await monitor.stop();
      await telegramTransport.close();
    }),
  );
}
