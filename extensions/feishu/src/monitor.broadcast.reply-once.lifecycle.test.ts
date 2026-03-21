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
  vi.fn(async () => ({ messageId: "om_sent", chatId: "oc_broadcast_group" })),
);

let handlersByAccount = new Map<string, Record<string, (data: unknown) => Promise<void>>>();
let runtimesByAccount = new Map<string, RuntimeEnv>();
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
    broadcast: {
      oc_broadcast_group: ["susan", "main"],
    },
    agents: {
      list: [{ id: "main" }, { id: "susan" }],
    },
    channels: {
      feishu: {
        enabled: true,
        groupPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        accounts: {
          "account-A": {
            enabled: true,
            appId: "cli_a",
            appSecret: "secret_a", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
              },
            },
          },
          "account-B": {
            enabled: true,
            appId: "cli_b",
            appSecret: "secret_b", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
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

function createLifecycleAccount(accountId: "account-A" | "account-B"): ResolvedFeishuAccount {
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: accountId === "account-A" ? "cli_a" : "cli_b",
    appSecret: accountId === "account-A" ? "secret_a" : "secret_b", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      groupPolicy: "open",
      requireMention: false,
      resolveSenderNames: false,
      groups: {
        oc_broadcast_group: {
          requireMention: false,
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

function createBroadcastEvent(messageId: string) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      chat_id: "oc_broadcast_group",
      chat_type: "group" as const,
      message_type: "text",
      content: JSON.stringify({ text: "hello broadcast" }),
      create_time: "1710000000000",
    },
  };
}

async function setupLifecycleMonitor(accountId: "account-A" | "account-B") {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlersByAccount.set(accountId, registered);
  });
  createEventDispatcherMock.mockReturnValueOnce({ register });

  const runtime = createRuntimeEnv();
  runtimesByAccount.set(accountId, runtime);

  await monitorSingleAccount({
    cfg: createLifecycleConfig(),
    account: createLifecycleAccount(accountId),
    runtime,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot_1",
      botName: "Bot",
    },
  });

  const onMessage = handlersByAccount.get(accountId)?.["im.message.receive_v1"];
  if (!onMessage) {
    throw new Error(`missing im.message.receive_v1 handler for ${accountId}`);
  }
  return onMessage;
}

describe("Feishu broadcast reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    handlersByAccount = new Map();
    runtimesByAccount = new Map();
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const activeDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(async () => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };

    createFeishuReplyDispatcherMock.mockReturnValue({
      dispatcher: activeDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "account-A",
      sessionKey: "agent:main:feishu:group:oc_broadcast_group",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    dispatchReplyFromConfigMock.mockImplementation(async ({ ctx, dispatcher }) => {
      if (
        typeof ctx?.SessionKey === "string" &&
        ctx.SessionKey.includes("agent:main:") &&
        typeof dispatcher?.sendFinalReply === "function"
      ) {
        await dispatcher.sendFinalReply({ text: "broadcast reply once" });
      }
      return {
        queuedFinal: false,
        counts: {
          final:
            typeof ctx?.SessionKey === "string" && ctx.SessionKey.includes("agent:main:") ? 1 : 0,
        },
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
            resolveStorePath: vi.fn(() => "/tmp/feishu-broadcast-sessions.json"),
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

  it("uses one active reply path when the same broadcast event reaches two accounts", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createBroadcastEvent("om_broadcast_once");

    await onMessageA(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
    });
    await onMessageB(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
      expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    });

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();

    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-a",
        chatId: "oc_broadcast_group",
        replyToMessageId: "om_broadcast_once",
      }),
    );

    const sessionKeys = finalizeInboundContextMock.mock.calls.map(
      (call) => (call[0] as { SessionKey?: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:group:oc_broadcast_group");
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc_broadcast_group");

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate delivery after a post-send failure on the first account", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createBroadcastEvent("om_broadcast_retry");

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      if (typeof ctx?.SessionKey === "string" && ctx.SessionKey.includes("agent:susan:")) {
        return { queuedFinal: false, counts: { final: 0 } };
      }
      await dispatcher.sendFinalReply({ text: "broadcast reply once" });
      throw new Error("post-send failure");
    });

    await onMessageA(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
    });
    await onMessageB(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
    });

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
