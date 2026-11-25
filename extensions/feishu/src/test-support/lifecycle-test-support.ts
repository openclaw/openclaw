import { randomUUID } from "node:crypto";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createInboundDebouncer, createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import { resolveFeishuAccount } from "../accounts.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  replyDispatcher,
  withFeishuRuntimeDefaults,
} from "../bot.test-support.js";
import { getFeishuLifecycleTestMocks } from "../lifecycle.test-support.js";
import { createFeishuTestIngressQueue } from "../monitor.test-mocks.js";
import { getFeishuRuntime, setFeishuRuntime } from "../runtime.js";
import type { ResolvedFeishuAccount } from "../types.js";

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
  return replyDispatcher(vi.fn(async () => false));
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
        createInboundDebouncer,
      },
      routing: { resolveAgentRoute },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async ({
          cfg,
          ctx,
          dispatcherOptions,
          replyOptions,
        }) => {
          const dispatcher = createReplyDispatcher(dispatcherOptions);
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
}: {
  dispatchReplyFromConfigMock: LifecycleMocks["dispatchReplyFromConfigMock"];
  replyText: string;
}) {
  dispatchReplyFromConfigMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
    await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    await dispatcher.sendFinalReply({ text: replyText });
    return { queuedFinal: false, counts: { final: 1 } };
  });
}

type LifecycleCredentials = { accountId: string; appId: string; appSecret: string };
type LifecycleConfigParams = LifecycleCredentials & {
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
};
const lifecycleDefaults = { enabled: true, requireMention: false, resolveSenderNames: false };
const lifecycleAccountDefaults = { ...lifecycleDefaults, connectionMode: "websocket" as const };

export function createFeishuLifecycleConfig(params: LifecycleConfigParams): ClawdbotConfig {
  return withFeishuRuntimeDefaults(
    createFeishuTestConfig(
      {
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
      {
        ...params.extraConfig,
        messages: { inbound: { debounceMs: 0, byChannel: { feishu: 0 } } },
      },
    ),
  );
}

export function createFeishuLifecycleFixture(params: LifecycleConfigParams) {
  const cfg = createFeishuLifecycleConfig(params);
  return { cfg, account: resolveFeishuAccount({ cfg, accountId: params.accountId }) };
}

export function createResolvedFeishuLifecycleAccount(
  params: LifecycleCredentials & { config: Record<string, unknown> },
): ResolvedFeishuAccount {
  return resolveFeishuAccount({
    cfg: createFeishuLifecycleConfig({ ...params, accountConfig: params.config }),
    accountId: params.accountId,
  });
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
  return createFeishuTestEvent({
    ...params,
    senderOpenId: params.senderOpenId ?? "ou_sender_1",
    senderType: "user",
    chatType: params.chatType ?? "group",
    message: {
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      create_time: "1710000000000",
    },
  });
}

type CallMock = ReturnType<typeof vi.fn>;
type LifecycleReplay = {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  waitTimeoutMs?: number;
};
type ReplyReplay = LifecycleReplay & { dispatchReplyFromConfigMock: CallMock };

async function expectReplayCallCounts(params: LifecycleReplay, first: CallMock[], second = first) {
  for (const mocks of [first, second]) {
    await params.handler(params.event);
    await vi.waitFor(
      () => {
        for (const mock of mocks) {
          expect(mock).toHaveBeenCalledTimes(1);
        }
      },
      { timeout: params.waitTimeoutMs ?? 10_000 },
    );
  }
}

export async function expectFeishuSingleEffectAcrossReplay(
  params: LifecycleReplay & { effectMock: CallMock },
) {
  await expectReplayCallCounts(params, [params.effectMock]);
}

export async function expectFeishuReplyPipelineDedupedAcrossReplay(
  params: ReplyReplay & { createFeishuReplyDispatcherMock: CallMock },
) {
  await expectReplayCallCounts(
    params,
    [params.dispatchReplyFromConfigMock],
    [params.dispatchReplyFromConfigMock, params.createFeishuReplyDispatcherMock],
  );
}

export async function expectFeishuReplyPipelineDedupedAfterPostSendFailure(
  params: ReplyReplay & { runtimeErrorMock: CallMock },
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
  createEventDispatcherMock: LifecycleMocks["createEventDispatcherMock"];
  runtime: RuntimeEnv;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  handlerKey: string;
  missingHandlerMessage: string;
}): Promise<LifecycleReplay["handler"]> {
  const dispatcher = new EventDispatcher({});
  const register = vi.spyOn(dispatcher, "register");
  params.createEventDispatcherMock.mockReturnValue(dispatcher);
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
  )?.[1] as LifecycleReplay["handler"] | undefined;
  if (!handler) {
    throw new Error(params.missingHandlerMessage);
  }
  return handler;
}
