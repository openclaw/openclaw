import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const createFeishuReplyDispatcherMock = vi.hoisted(() => vi.fn());
const resolveBoundConversationMock = vi.hoisted(() => vi.fn(() => null));
const touchBindingMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const dispatchReplyFromConfigMock = vi.hoisted(() => vi.fn());
const withReplyDispatcherMock = vi.hoisted(() => vi.fn());
const finalizeInboundContextMock = vi.hoisted(() => vi.fn((ctx) => ctx));
const sendMessageFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_notice", chatId: "p2p:ou_user1" })),
);
const sendCardFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_card", chatId: "p2p:ou_user1" })),
);
const getMessageFeishuMock = vi.hoisted(() => vi.fn(async () => null));
const listFeishuThreadMessagesMock = vi.hoisted(() => vi.fn(async () => []));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: RuntimeEnv | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createEventDispatcher: createEventDispatcherMock,
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: createFeishuReplyDispatcherMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
  listFeishuThreadMessages: listFeishuThreadMessagesMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      resolveByConversation: resolveBoundConversationMock,
      touch: touchBindingMock,
    }),
  };
});

vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    resolveByConversation: resolveBoundConversationMock,
    touch: touchBindingMock,
  }),
}));

function createLifecycleConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        accounts: {
          "acct-card": {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test", // pragma: allowlist secret
            connectionMode: "websocket",
            dmPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
          },
        },
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 0,
        },
      },
    },
  } as ClawdbotConfig;
}

function createLifecycleAccount(): ResolvedFeishuAccount {
  return {
    accountId: "acct-card",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      dmPolicy: "open",
      requireMention: false,
      resolveSenderNames: false,
    },
  } as ResolvedFeishuAccount;
}

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as RuntimeEnv;
}

function createCardActionEvent(params: {
  token: string;
  action: string;
  command: string;
  chatId?: string;
  chatType?: "group" | "p2p";
}) {
  const openId = "ou_user1";
  const chatId = params.chatId ?? "p2p:ou_user1";
  const chatType = params.chatType ?? "p2p";
  return {
    operator: {
      open_id: openId,
      user_id: "user_1",
      union_id: "union_1",
    },
    token: params.token,
    action: {
      tag: "button",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: params.action,
        q: params.command,
        c: {
          u: openId,
          h: chatId,
          t: chatType,
          e: Date.now() + 60_000,
        },
      }),
    },
    context: {
      open_id: openId,
      user_id: "user_1",
      chat_id: chatId,
    },
  };
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function setupLifecycleMonitor() {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  lastRuntime = createRuntimeEnv();

  await monitorSingleAccount({
    cfg: createLifecycleConfig(),
    account: createLifecycleAccount(),
    runtime: lastRuntime,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot_1",
      botName: "Bot",
    },
  });

  const onCardAction = handlers["card.action.trigger"];
  if (!onCardAction) {
    throw new Error("missing card.action.trigger handler");
  }
  return onCardAction;
}

describe("Feishu card-action lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    lastRuntime = null;
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-card-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const dispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(async () => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };

    createFeishuReplyDispatcherMock.mockReturnValue({
      dispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    resolveBoundConversationMock.mockReturnValue({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    });

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-card",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    dispatchReplyFromConfigMock.mockImplementation(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      return {
        queuedFinal: false,
        counts: { final: 1 },
      };
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          debounce: {
            resolveInboundDebounceMs: vi.fn(() => 0),
            createInboundDebouncer: <T>(params: {
              onFlush?: (items: T[]) => Promise<void>;
              onError?: (err: unknown, items: T[]) => void;
            }) => ({
              enqueue: async (item: T) => {
                try {
                  await params.onFlush?.([item]);
                } catch (err) {
                  params.onError?.(err, [item]);
                }
              },
              flushKey: async () => {},
            }),
          },
          text: {
            hasControlCommand: vi.fn(() => false),
          },
          routing: {
            resolveAgentRoute:
              resolveAgentRouteMock as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(() => ({})),
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig:
              dispatchReplyFromConfigMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
            withReplyDispatcher:
              withReplyDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          session: {
            readSessionUpdatedAt: vi.fn(),
            resolveStorePath: vi.fn(() => "/tmp/feishu-card-action-sessions.json"),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn(),
            buildPairingReply: vi.fn(),
          },
        },
        media: {
          detectMime: vi.fn(async () => "text/plain"),
        },
      }) as unknown as PluginRuntime,
    );
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("routes one reply across duplicate callback delivery", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-once",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await onCardAction(event);
    await settleAsyncWork();
    await onCardAction(event);
    await settleAsyncWork();

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "p2p:ou_user1",
        replyToMessageId: "card-action-tok-card-once",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-card",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "card-action-tok-card-once",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

    const dispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not duplicate delivery when retrying after a post-send failure", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-retry",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      throw new Error("post-send failure");
    });

    await onCardAction(event);
    await settleAsyncWork();
    await onCardAction(event);
    await settleAsyncWork();

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);

    const dispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
