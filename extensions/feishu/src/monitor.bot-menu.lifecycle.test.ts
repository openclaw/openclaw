import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

type BoundConversation = {
  bindingId: string;
  targetSessionKey: string;
};

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const createFeishuReplyDispatcherMock = vi.hoisted(() => vi.fn());
const resolveBoundConversationMock = vi.hoisted(() =>
  vi.fn<() => BoundConversation | null>(() => null),
);
const touchBindingMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const dispatchReplyFromConfigMock = vi.hoisted(() => vi.fn());
const withReplyDispatcherMock = vi.hoisted(() => vi.fn());
const finalizeInboundContextMock = vi.hoisted(() => vi.fn((ctx) => ctx));
const sendCardFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_card_sent", chatId: "p2p:ou_user1" })),
);
const getMessageFeishuMock = vi.hoisted(() => vi.fn(async () => null));
const listFeishuThreadMessagesMock = vi.hoisted(() => vi.fn(async () => []));
const sendMessageFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_sent", chatId: "p2p:ou_user1" })),
);

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
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
  listFeishuThreadMessages: listFeishuThreadMessagesMock,
  sendMessageFeishu: sendMessageFeishuMock,
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

function createLifecycleConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        accounts: {
          "acct-menu": {
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
    accountId: "acct-menu",
    selectionSource: "explicit",
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
  } as unknown as ResolvedFeishuAccount;
}

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as RuntimeEnv;
}

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
    },
  };
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

  const onBotMenu = handlers["application.bot.menu_v6"];
  if (!onBotMenu) {
    throw new Error("missing application.bot.menu_v6 handler");
  }
  return onBotMenu;
}

describe("Feishu bot-menu lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    handlers = {};
    lastRuntime = null;
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-bot-menu-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-menu",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-menu",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    dispatchReplyFromConfigMock.mockImplementation(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "menu reply once" });
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
            resolveStorePath: vi.fn(() => "/tmp/feishu-bot-menu-sessions.json"),
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
    vi.useRealTimers();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("opens one launcher card across duplicate quick-actions replay", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000000",
    });

    await onBotMenu(event);
    await vi.waitFor(() => {
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    });
    await onBotMenu(event);
    await vi.waitFor(() => {
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        to: "user:ou_user1",
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
    expect(createFeishuReplyDispatcherMock).not.toHaveBeenCalled();
  });

  it("falls back once to the legacy routed reply path when launcher rendering fails", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000001",
    });
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));

    await onBotMenu(event);
    await vi.waitFor(() => {
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    });
    await onBotMenu(event);
    await vi.waitFor(() => {
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        chatId: "p2p:ou_user1",
        replyToMessageId: "bot-menu:quick-actions:1700000000001",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-menu",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "bot-menu:quick-actions:1700000000001",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-menu");

    const dispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
