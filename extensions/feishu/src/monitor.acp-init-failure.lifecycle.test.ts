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
const resolveBoundConversationMock = vi.hoisted(() => vi.fn(() => null));
const touchBindingMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const dispatchReplyFromConfigMock = vi.hoisted(() => vi.fn());
const withReplyDispatcherMock = vi.hoisted(() => vi.fn());
const finalizeInboundContextMock = vi.hoisted(() => vi.fn((ctx) => ctx));
const sendMessageFeishuMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "om_notice", chatId: "oc_group_topic" })),
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

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
  listFeishuThreadMessages: listFeishuThreadMessagesMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    resolveConfiguredBindingRoute: (params: unknown) => resolveConfiguredBindingRouteMock(params),
    ensureConfiguredBindingRouteReady: (params: unknown) =>
      ensureConfiguredBindingRouteReadyMock(params),
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
    session: { mainKey: "main", scope: "per-sender" },
    channels: {
      feishu: {
        enabled: true,
        groupPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        allowFrom: ["ou_sender_1"],
        accounts: {
          "acct-acp": {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_group_topic: {
                requireMention: false,
                groupSessionScope: "group_topic",
                replyInThread: "enabled",
              },
            },
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
    accountId: "acct-acp",
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
        oc_group_topic: {
          requireMention: false,
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        },
      },
      allowFrom: ["ou_sender_1"],
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

function createTopicEvent(messageId: string) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      root_id: "om_topic_root_1",
      thread_id: "omt_topic_1",
      chat_id: "oc_group_topic",
      chat_type: "group" as const,
      message_type: "text",
      content: JSON.stringify({ text: "hello topic" }),
      create_time: "1710000000000",
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

  const onMessage = handlers["im.message.receive_v1"];
  if (!onMessage) {
    throw new Error("missing im.message.receive_v1 handler");
  }
  return onMessage;
}

describe("Feishu ACP-init failure lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    lastRuntime = null;
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-acp-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-acp",
      sessionKey: "agent:main:feishu:group:oc_group_topic",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: {
        configuredBinding: {
          spec: {
            channel: "feishu",
            accountId: "acct-acp",
            conversationId: "oc_group_topic:topic:om_topic_root_1",
            agentId: "codex",
            mode: "persistent",
          },
          record: {
            bindingId: "config:acp:feishu:acct-acp:oc_group_topic:topic:om_topic_root_1",
            targetSessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
            targetKind: "session",
            conversation: {
              channel: "feishu",
              accountId: "acct-acp",
              conversationId: "oc_group_topic:topic:om_topic_root_1",
              parentConversationId: "oc_group_topic",
            },
            status: "active",
            boundAt: 0,
            metadata: { source: "config" },
          },
        },
        statefulTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
          agentId: "codex",
        },
      },
      configuredBinding: {
        spec: {
          channel: "feishu",
          accountId: "acct-acp",
          conversationId: "oc_group_topic:topic:om_topic_root_1",
          agentId: "codex",
          mode: "persistent",
        },
      },
      route: {
        agentId: "codex",
        channel: "feishu",
        accountId: "acct-acp",
        sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
      },
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "runtime unavailable",
    });

    dispatchReplyFromConfigMock.mockResolvedValue({
      queuedFinal: false,
      counts: { final: 0 },
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
            resolveStorePath: vi.fn(() => "/tmp/feishu-acp-failure-sessions.json"),
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

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createTopicEvent("om_topic_msg_1");

    await onMessage(event);
    await settleAsyncWork();
    await onMessage(event);
    await settleAsyncWork();

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-acp",
        to: "chat:oc_group_topic",
        replyToMessageId: "om_topic_root_1",
        replyInThread: true,
        text: expect.stringContaining("runtime unavailable"),
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });

  it("does not duplicate the ACP failure notice after the first send succeeds", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createTopicEvent("om_topic_msg_2");

    await onMessage(event);
    await settleAsyncWork();
    await onMessage(event);
    await settleAsyncWork();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(lastRuntime?.error).not.toHaveBeenCalled();
  });
});
