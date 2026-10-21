import { randomUUID } from "node:crypto";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { InboundDebounceCreateParams } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import { withFeishuRuntimeDefaults } from "../bot.test-support.js";
import { getFeishuLifecycleTestMocks } from "../lifecycle.test-support.js";
import { createFeishuTestIngressQueue } from "../monitor.test-mocks.js";
import { getFeishuRuntime, setFeishuRuntime } from "../runtime.js";
import type { ResolvedFeishuAccount } from "../types.js";

const FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS = 10_000;
const activeMonitors = new Set<{ controller: AbortController; completion: Promise<void> }>();

export async function stopFeishuLifecycleMonitors(): Promise<void> {
  const monitors = [...activeMonitors];
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  const results = await Promise.allSettled(monitors.map((monitor) => monitor.completion));
  results.push(...(await Promise.allSettled([closeOpenClawStateDatabaseAsync()])));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Feishu lifecycle test cleanup failed");
  }
  activeMonitors.clear();
}
type ChannelRuntime = PluginRuntime["channel"];
type LifecycleMocks = ReturnType<typeof getFeishuLifecycleTestMocks>;
type RuntimeReplyDispatcher = NonNullable<
  Parameters<ChannelRuntime["reply"]["withReplyDispatcher"]>[0]["dispatcher"]
>;

export function setFeishuLifecycleStateDir(prefix: string) {
  process.env.OPENCLAW_STATE_DIR = `/tmp/${prefix}-${randomUUID()}`;
}

export function restoreFeishuLifecycleStateDir(originalStateDir: string | undefined) {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    return;
  }
  process.env.OPENCLAW_STATE_DIR = originalStateDir;
}

export function createFeishuLifecycleReplyDispatcher() {
  return {
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => {}) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(async () => false),
  };
}

export function installFeishuLifecycleReplyRuntime(params: {
  resolveAgentRouteMock: unknown;
  dispatchReplyFromConfigMock: unknown;
  withReplyDispatcherMock: unknown;
  storePath: string;
}): PluginRuntime {
  const resolveAgentRoute =
    params.resolveAgentRouteMock as ChannelRuntime["routing"]["resolveAgentRoute"];
  const dispatchReplyFromConfig =
    params.dispatchReplyFromConfigMock as ChannelRuntime["reply"]["dispatchReplyFromConfig"];
  const withReplyDispatcher =
    params.withReplyDispatcherMock as ChannelRuntime["reply"]["withReplyDispatcher"];
  const runtime = createPluginRuntimeMock({
    state: { openChannelIngressQueue: createFeishuTestIngressQueue },
    channel: {
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 0),
        createInboundDebouncer: <T>(options: InboundDebounceCreateParams<T>) => ({
          shouldBuffer: () => false,
          enqueue: async (item: T) => {
            try {
              await options.onFlush?.([item], createTestInboundDebounceFlush).completion;
            } catch (err) {
              options.onError?.(err, [item]);
            }
          },
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        }),
      },
      routing: { resolveAgentRoute },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async ({
          cfg,
          ctx,
          dispatcherOptions,
          replyOptions,
        }) => {
          // ReplyDispatcher enqueue methods are synchronous; settlement owns async delivery.
          const pendingDeliveries: Promise<unknown>[] = [];
          const dispatcher: RuntimeReplyDispatcher = {
            sendToolResult: () => false,
            sendBlockReply: () => false,
            sendFinalReply: (payload) => {
              pendingDeliveries.push(
                Promise.resolve(dispatcherOptions.deliver(payload, { kind: "final" })),
              );
              return true;
            },
            waitForIdle: async () => {
              await Promise.all(pendingDeliveries);
            },
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            markComplete: () => {},
          };
          return await withReplyDispatcher({
            dispatcher,
            run: () =>
              dispatchReplyFromConfig({
                cfg,
                ctx: ctx as Parameters<typeof dispatchReplyFromConfig>[0]["ctx"],
                dispatcher,
                replyOptions,
              }),
          });
        },
        dispatchReplyFromConfig,
        withReplyDispatcher,
      },
      commands: { shouldComputeCommandAuthorized: vi.fn(() => false) },
      session: { resolveStorePath: vi.fn(() => params.storePath) },
      pairing: { upsertPairingRequest: vi.fn() },
    },
  }) as unknown as PluginRuntime;
  setFeishuRuntime(runtime);
  return runtime;
}

export function mockFeishuReplyOnceDispatch({
  dispatchReplyFromConfigMock,
  replyText,
  shouldSendFinalReply: shouldSend,
}: {
  dispatchReplyFromConfigMock: LifecycleMocks["dispatchReplyFromConfigMock"];
  replyText: string;
  shouldSendFinalReply?: (ctx: unknown) => boolean;
}) {
  dispatchReplyFromConfigMock.mockImplementation(async ({ ctx, dispatcher, replyOptions }) => {
    await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    const shouldSendFinalReply = shouldSend?.(ctx) ?? true;
    if (shouldSendFinalReply && typeof dispatcher?.sendFinalReply === "function") {
      await dispatcher.sendFinalReply({ text: replyText });
    }
    return { queuedFinal: false, counts: { final: shouldSendFinalReply ? 1 : 0 } };
  });
}

type LifecycleCredentials = { accountId: string; appId: string; appSecret: string };
type LifecycleConfigParams = LifecycleCredentials & {
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
};
const lifecycleDefaults = { enabled: true, requireMention: false, resolveSenderNames: false };
const lifecycleAccountDefaults = { ...lifecycleDefaults, connectionMode: "websocket" };

export function createFeishuLifecycleConfig(params: LifecycleConfigParams): ClawdbotConfig {
  const extraConfig = params.extraConfig ?? {};
  return withFeishuRuntimeDefaults({
    ...extraConfig,
    channels: {
      ...(extraConfig.channels as Record<string, unknown> | undefined),
      feishu: {
        ...lifecycleDefaults,
        ...params.channelConfig,
        accounts: {
          [params.accountId]: {
            ...lifecycleAccountDefaults,
            appId: params.appId,
            appSecret: params.appSecret, // pragma: allowlist secret
            ...params.accountConfig,
          },
        },
      },
    },
    messages: { inbound: { debounceMs: 0, byChannel: { feishu: 0 } } },
  } as ClawdbotConfig);
}

export function createFeishuLifecycleFixture(params: LifecycleConfigParams) {
  return {
    cfg: createFeishuLifecycleConfig(params),
    account: createResolvedFeishuLifecycleAccount({
      accountId: params.accountId,
      appId: params.appId,
      appSecret: params.appSecret,
      config: { ...params.channelConfig, ...params.accountConfig },
    }),
  };
}

export function createResolvedFeishuLifecycleAccount(
  params: LifecycleCredentials & { config: Record<string, unknown> },
): ResolvedFeishuAccount {
  return {
    accountId: params.accountId,
    enabled: true,
    configured: true,
    appId: params.appId,
    appSecret: params.appSecret, // pragma: allowlist secret
    domain: "feishu",
    config: withFeishuRuntimeDefaults({
      channels: { feishu: { ...lifecycleAccountDefaults, ...params.config } },
    }).channels?.feishu,
  } as unknown as ResolvedFeishuAccount;
}

export function createFeishuTextMessageEvent(params: {
  messageId: string;
  chatId: string;
  text: string;
  chatType?: "group" | "p2p";
  senderOpenId?: string;
  rootId?: string;
  threadId?: string;
}) {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId ?? "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      chat_id: params.chatId,
      chat_type: params.chatType ?? "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      create_time: "1710000000000",
    },
  };
}

async function expectFeishuLifecycleEventually(assertion: LifecycleAssertion, timeoutMs: number) {
  try {
    await assertion();
  } catch {
    await vi.waitFor(assertion, { timeout: timeoutMs });
  }
}

type LifecycleAssertion = () => void | Promise<void>;
type CallMock = ReturnType<typeof vi.fn>;
type LifecycleReplay = {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  waitTimeoutMs?: number;
};

async function expectReplayCallCounts(
  params: LifecycleReplay,
  first: CallMock[],
  second = first,
  count = 1,
) {
  await runFeishuLifecycleSequence(
    [() => params.handler(params.event), () => params.handler(params.event)],
    [first, second].map((mocks) => () => {
      for (const mock of mocks) {
        expect(mock).toHaveBeenCalledTimes(count);
      }
    }),
    params.waitTimeoutMs,
  );
}

export async function runFeishuLifecycleSequence(
  deliveries: Array<() => Promise<void>>,
  waits: LifecycleAssertion[],
  timeoutMs = FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS,
) {
  for (const [index, deliver] of deliveries.entries()) {
    await deliver();
    await expectFeishuLifecycleEventually(waits[index] ?? waits.at(-1) ?? (() => {}), timeoutMs);
  }
}

export async function expectFeishuSingleEffectAcrossReplay(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  effectMock: CallMock;
  effectCount?: number;
}) {
  await expectReplayCallCounts(params, [params.effectMock], undefined, params.effectCount ?? 1);
}

export async function expectFeishuReplyPipelineDedupedAcrossReplay(
  params: LifecycleReplay & {
    dispatchReplyFromConfigMock: CallMock;
    createFeishuReplyDispatcherMock: CallMock;
  },
) {
  await expectReplayCallCounts(
    params,
    [params.dispatchReplyFromConfigMock],
    [params.dispatchReplyFromConfigMock, params.createFeishuReplyDispatcherMock],
  );
}

export async function expectFeishuReplyPipelineDedupedAfterPostSendFailure(
  params: LifecycleReplay & {
    dispatchReplyFromConfigMock: CallMock;
    runtimeErrorMock: CallMock;
  },
) {
  await expectReplayCallCounts(params, [
    params.dispatchReplyFromConfigMock,
    params.runtimeErrorMock,
  ]);
}

export function expectFeishuReplyDispatcherSentFinalReplyOnce(params: {
  createFeishuReplyDispatcherMock: LifecycleMocks["createFeishuReplyDispatcherMock"];
}) {
  const delivery = params.createFeishuReplyDispatcherMock.mock.results[0]?.value.delivery;
  expect(delivery.deliver).toHaveBeenCalledTimes(1);
}

export async function setupFeishuLifecycleHandler(params: {
  createEventDispatcherMock: {
    mockReturnValue: (value: unknown) => unknown;
    mockReturnValueOnce: (value: unknown) => unknown;
  };
  runtime: RuntimeEnv;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  handlerKey: string;
  missingHandlerMessage: string;
  once?: boolean;
}): Promise<(data: unknown) => Promise<void>> {
  const dispatcher = new EventDispatcher({});
  const register = vi.spyOn(dispatcher, "register");
  params.createEventDispatcherMock[params.once ? "mockReturnValueOnce" : "mockReturnValue"](
    dispatcher,
  );
  getFeishuRuntime().config.current = vi.fn(
    () => params.cfg,
  ) as unknown as PluginRuntime["config"]["current"];

  const { monitorSingleAccount } = await import("../monitor.account.js");
  const started = createDeferred<void>();
  const controller = new AbortController();
  getFeishuLifecycleTestMocks().monitorWebSocketMock.mockImplementationOnce(async () => {
    started.resolve();
    if (!controller.signal.aborted) {
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });
  const completion = monitorSingleAccount({
    cfg: params.cfg,
    account: params.account,
    runtime: params.runtime,
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot_1" },
    fireAndForget: false,
    abortSignal: controller.signal,
  });
  activeMonitors.add({ controller, completion });
  void completion.catch(started.reject);
  await started.promise;

  const handler = Object.entries(register.mock.calls.at(0)?.[0] ?? {}).find(
    ([key]) => key === params.handlerKey,
  )?.[1] as ((data: unknown) => Promise<void>) | undefined;
  if (!handler) {
    throw new Error(params.missingHandlerMessage);
  }
  return handler;
}
