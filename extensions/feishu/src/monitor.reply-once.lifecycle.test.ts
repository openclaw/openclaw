import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const createFeishuReplyDispatcherMock = vi.hoisted(() => vi.fn());
const resolveBoundConversationMock = vi.hoisted(() =>
  vi.fn<
    () => {
      bindingId: string;
      targetSessionKey: string;
    } | null
  >(() => null),
);
const touchBindingMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const dispatchReplyFromConfigMock = vi.hoisted(() => vi.fn());
const withReplyDispatcherMock = vi.hoisted(() => vi.fn());
const finalizeInboundContextMock = vi.hoisted(() => vi.fn((ctx) => ctx));
const getMessageFeishuMock = vi.hoisted(() => vi.fn(async () => null));
const listFeishuThreadMessagesMock = vi.hoisted(() => vi.fn(async () => []));
const sendMessageFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_sent", chatId: "oc_group_1" })),
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
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 0,
        },
      },
    },
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          "acct-lifecycle": {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_group_1: {
                requireMention: false,
                groupSessionScope: "group_topic_sender",
                replyInThread: "enabled",
              },
            },
          },
        },
      },
    },
  } as ClawdbotConfig;
}

function createLifecycleAccount(): ResolvedFeishuAccount {
  return {
    accountId: "acct-lifecycle",
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      groupPolicy: "open",
      requireMention: false,
      resolveSenderNames: false,
      groups: {
        oc_group_1: {
          requireMention: false,
          groupSessionScope: "group_topic_sender",
          replyInThread: "enabled",
        },
      },
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

function createTextEvent(messageId: string) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      root_id: "om_root_topic_1",
      thread_id: "omt_topic_1",
      chat_id: "oc_group_1",
      chat_type: "group" as const,
      message_type: "text",
      content: JSON.stringify({ text: "hello from topic" }),
      create_time: "1710000000000",
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

  const onMessage = handlers["im.message.receive_v1"];
  if (!onMessage) {
    throw new Error("missing im.message.receive_v1 handler");
  }
  return onMessage;
}

describe("Feishu reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    handlers = {};
    lastRuntime = null;
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
      bindingId: "binding-1",
      targetSessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
    });

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-lifecycle",
      sessionKey: "agent:main:feishu:group:oc_group_1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    dispatchReplyFromConfigMock.mockImplementation(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "reply once" });
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
            resolveStorePath: vi.fn(() => "/tmp/feishu-lifecycle-sessions.json"),
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

  it("routes a topic-bound inbound event and emits one reply across duplicate replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createTextEvent("om_lifecycle_once");

    await onMessage(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    });
    await onMessage(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-lifecycle",
        chatId: "oc_group_1",
        replyToMessageId: "om_root_topic_1",
        replyInThread: true,
        rootId: "om_root_topic_1",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-lifecycle",
        SessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
        MessageSid: "om_lifecycle_once",
        MessageThreadId: "om_root_topic_1",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-1");

    const dispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate delivery when the first attempt fails after sending the reply", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createTextEvent("om_lifecycle_retry");

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "reply once" });
      throw new Error("post-send failure");
    });

    await onMessage(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    });
    await onMessage(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    const dispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
