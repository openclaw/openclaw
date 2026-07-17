// Feishu tests cover bot.broadcast plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  builtInboundContextCalls,
  mockCreateFeishuReplyDispatcher,
  mockCreateFeishuClient,
  mockDispatchInboundMessage,
  mockRecordInboundSession,
  mockResolveAgentRoute,
  mockResolveStorePath,
} = vi.hoisted(() => ({
  builtInboundContextCalls: [] as Array<Record<string, unknown>>,
  mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => ({
    dispatcher: {
      sendToolResult: vi.fn(),
      sendBlockReply: vi.fn(),
      sendFinalReply: vi.fn(),
      waitForIdle: vi.fn(),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
  mockCreateFeishuClient: vi.fn(),
  mockDispatchInboundMessage: vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockRecordInboundSession: vi.fn().mockResolvedValue(undefined),
  mockResolveAgentRoute: vi.fn(),
  mockResolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    buildChannelInboundEventContext: (
      params: Parameters<typeof actual.buildChannelInboundEventContext>[0],
    ) =>
      actual.buildChannelInboundEventContext({
        ...params,
        finalize: (ctx) => {
          builtInboundContextCalls.push(ctx);
          return ctx as never;
        },
      }),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return { ...actual, dispatchInboundMessage: mockDispatchInboundMessage };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return { ...actual, resolveStorePath: mockResolveStorePath };
});

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("broadcast dispatch", () => {
  const mockGetChatInfo = vi.fn();
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });
  const runtimeStub = {
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => mockResolveAgentRoute(params),
      },
      session: {
        resolveStorePath: mockResolveStorePath,
        recordInboundSession: mockRecordInboundSession,
      },
      reply: {},
      commands: {
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: mockSaveMediaBuffer,
      },
      inbound: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const eventClass = {
            kind: "message" as const,
            canStartAgentTurn: true,
          };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("runDispatch" in turn)) {
            throw new Error("feishu broadcast test runtime only supports prepared turns");
          }
          const routeSessionKey = "route" in turn ? turn.route.sessionKey : turn.routeSessionKey;
          const storePath = "storePath" in turn ? turn.storePath : mockResolveStorePath();
          const recordInboundSession =
            "recordInboundSession" in turn ? turn.recordInboundSession : mockRecordInboundSession;
          await recordInboundSession({
            storePath,
            sessionKey: turn.ctxPayload.SessionKey ?? routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey,
            dispatchResult: await turn.runDispatch(),
          };
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
        buildPairingReply: vi.fn(() => "Pairing response"),
      },
    },
    media: {
      detectMime: vi.fn(async () => "application/octet-stream"),
    },
  } as unknown as PluginRuntime;

  afterAll(() => {
    vi.doUnmock("./reply-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  function createBroadcastConfig(): ClawdbotConfig {
    return {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    };
  }

  function createBroadcastEvent(options: {
    messageId: string;
    text: string;
    botMentioned?: boolean;
  }): FeishuMessageEvent {
    return {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: options.messageId,
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
        ...(options.botMentioned
          ? {
              mentions: [
                {
                  key: "@_user_1",
                  id: { open_id: "bot-open-id" },
                  name: "Bot",
                  tenant_key: "",
                },
              ],
            }
          : {}),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchInboundMessage.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    feishuGroupNameCache.clear();
    builtInboundContextCalls.length = 0;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback: vi.fn(),
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({
            code: 0,
            data: { name: "Broadcast Team" },
          }),
        },
      },
    });
    setFeishuRuntime(runtimeStub);
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-mentioned",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(2);
    const sessionKeys = builtInboundContextCalls.map((call) => call.SessionKey);
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    const recordCalls = (
      runtimeStub.channel.session.recordInboundSession as unknown as {
        mock: {
          calls: Array<
            [
              {
                updateLastRoute?: {
                  sessionKey?: unknown;
                  channel?: unknown;
                  to?: unknown;
                };
              },
            ]
          >;
        };
      }
    ).mock.calls;
    expect(
      recordCalls
        .map(([call]) => ({
          sessionKey: call.updateLastRoute?.["sessionKey"],
          channel: call.updateLastRoute?.["channel"],
          to: call.updateLastRoute?.["to"],
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
    ]);
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
    expect(
      builtInboundContextCalls
        .map((call) => ({
          sessionKey: call.SessionKey,
          groupSubject: call.GroupSubject,
          conversationLabel: call.ConversationLabel,
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
    ]);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls.at(0)?.[0] as
      | { agentId?: string }
      | undefined;
    expect(dispatcherParams?.agentId).toBe("main");
  });

  it("sends no-visible-reply fallback for active broadcast zero-final dispatch", async () => {
    mockDispatchInboundMessage
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-zero-final",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("sends no-visible-reply fallback for active broadcast failed final delivery", async () => {
    mockDispatchInboundMessage
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: true,
        counts: { final: 1 },
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-final-failed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("skips no-visible-reply fallback for source-suppressed active broadcast dispatch", async () => {
    mockDispatchInboundMessage
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-source-suppressed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-not-mentioned",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "ou_known_bot",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot identity is unknown (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-unknown-bot-id",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(builtInboundContextCalls).toHaveLength(1);
    expect(builtInboundContextCalls[0]?.SessionKey).toBe(
      "agent:main:feishu:group:oc-broadcast-group",
    );
    expect(builtInboundContextCalls[0]?.GroupSubject).toBe("Broadcast Team");
    expect(builtInboundContextCalls[0]?.ConversationLabel).toBe("Broadcast Team");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(2);

    mockDispatchInboundMessage.mockClear();
    mockGetChatInfo.mockClear();
    builtInboundContextCalls.length = 0;

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(1);
    const sessionKey =
      typeof builtInboundContextCalls[0]?.SessionKey === "string"
        ? builtInboundContextCalls[0].SessionKey
        : "";
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
