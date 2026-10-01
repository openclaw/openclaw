import {
  buildChannelInboundEventContext,
  type BuiltChannelInboundEventContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentRoute, type ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveGroupSessionKey } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage, parseFeishuMessageEvent } from "./bot.js";
import {
  createBoundConversation,
  createConfiguredBindingReadiness,
  createConfiguredFeishuRoute,
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { parseMergeForwardContent } from "./message-content.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { getFeishuRuntime, setFeishuRuntime } from "./runtime.js";
import { setFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";

const emptyDeliveryCounts = {
  delivered: 0,
  deliveredNotVisible: 0,
  cancelled: 0,
  failedBeforeSend: 0,
  failedAfterSend: 0,
};
const failedFinalReceipt = {
  counts: {
    tool: { ...emptyDeliveryCounts },
    block: { ...emptyDeliveryCounts },
    final: { ...emptyDeliveryCounts, failedBeforeSend: 1 },
  },
  anyVisibleDelivered: false,
} as const;

type RecordedSession = Parameters<PluginRuntime["channel"]["session"]["recordInboundSession"]>[0];
type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>>;
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

let currentRuntimeConfig = {} as ClawdbotConfig;

function sentMessage(
  messageId: string,
  chatId: string,
): Awaited<ReturnType<typeof import("./send.js").sendMessageFeishu>> {
  return {
    messageId,
    chatId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt: 1,
    },
  };
}

function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const runtime = {
    config: {
      current: vi.fn(() => currentRuntimeConfig),
    },
    channel: {
      routing: {
        resolveAgentRoute: mockResolveAgentRoute,
      },
      session: {
        readSessionUpdatedAt: mockReadSessionUpdatedAt,
        resolveStorePath: mockResolveStorePath,
        recordInboundSession: vi.fn(async () => undefined),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue(["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
        run: vi.fn(async (params) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const turn = await params.adapter.resolveTurn(
            input,
            {
              kind: "message",
              canStartAgentTurn: true,
            },
            {},
          );
          await runtime.channel.session.recordInboundSession({
            storePath: runtime.channel.session.resolveStorePath(turn.cfg.session?.store, {
              agentId: turn.route.agentId,
            }),
            sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.route.sessionKey,
            dispatchResult:
              turn.admission?.kind === "observeOnly"
                ? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }
                : await mockDispatchInboundMessage({
                    ctx: turn.ctxPayload,
                    cfg: turn.cfg,
                    replyOptions: turn.replyOptions,
                  }),
          };
        }),
      },
      ...overrides.channel,
    },
    ...(overrides.system ? { system: overrides.system as PluginRuntime["system"] } : {}),
    ...(overrides.media ? { media: overrides.media as PluginRuntime["media"] } : {}),
  } as unknown as PluginRuntime;
  return runtime;
}

function mockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  _type?: (value: unknown) => value is T,
): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call[argIndex] as T;
}

type FeishuRoutePeer = { id: string; kind: "direct" | "group" };

function expectResolvedRouteCall(
  callIndex: number,
  peer: FeishuRoutePeer,
  parentPeer?: FeishuRoutePeer | null,
): void {
  const routeRequest = mockCallArg<{
    parentPeer?: FeishuRoutePeer | null;
    peer?: FeishuRoutePeer;
  }>(mockResolveAgentRoute, callIndex, 0);
  expect(routeRequest.peer).toEqual(peer);
  if (arguments.length >= 3) {
    expect(routeRequest.parentPeer).toEqual(parentPeer);
  }
}

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockListFeishuThreadMessages,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
  mockReadSessionUpdatedAt,
  mockResolveStorePath,
  mockResolveConfiguredBindingRoute,
  mockEnsureConfiguredBindingRouteReady,
  mockResolveBoundConversation,
  mockTouchBinding,
  mockResolveFeishuReasoningPreviewEnabled,
  mockTranscribeFirstAudio,
  mockMaybeCreateDynamicAgent,
  mockBuildChannelInboundEventContext,
  mockFormatAgentEnvelope,
  mockDispatchInboundMessage,
  mockResolveFeishuBotName,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(
    (
      _params: Parameters<typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher>[0],
    ) => ({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    }),
  ),
  mockSendMessageFeishu: vi
    .fn<typeof import("./send.js").sendMessageFeishu>()
    .mockResolvedValue(sentMessage("pairing-msg", "oc-dm")),
  mockGetMessageFeishu: vi
    .fn<typeof import("./send.js").getMessageFeishu>()
    .mockResolvedValue(null),
  mockListFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  mockDownloadMessageResourceFeishu: vi
    .fn<typeof import("./media.js").saveMessageResourceFeishu>()
    .mockResolvedValue({
      saved: {
        id: "inbound-clip.mp4",
        path: "/tmp/inbound-clip.mp4",
        size: Buffer.byteLength("video"),
        contentType: "video/mp4",
      },
    }),
  mockCreateFeishuClient: vi.fn(),
  mockResolveAgentRoute: vi.fn((_params?: unknown) => createFeishuTestRoute()),
  mockReadSessionUpdatedAt: vi.fn((_params?: unknown): number | undefined => undefined),
  mockResolveStorePath: vi.fn((_params?: unknown) => "/tmp/feishu-sessions.json"),
  mockResolveConfiguredBindingRoute: vi.fn(
    ({
      route,
    }: {
      route: NonNullable<ConfiguredBindingRoute>["route"];
    }): ConfiguredBindingRoute => ({
      bindingResolution: null,
      route,
    }),
  ),
  mockEnsureConfiguredBindingRouteReady: vi.fn(
    async (_params?: unknown): Promise<BindingReadiness> => ({ ok: true }),
  ),
  mockResolveBoundConversation: vi.fn((_ref?: unknown) => null as BoundConversation),
  mockTouchBinding: vi.fn(),
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
  mockTranscribeFirstAudio:
    vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudio>(),
  mockMaybeCreateDynamicAgent: vi.fn(),
  mockBuildChannelInboundEventContext: vi.fn<(ctx: BuiltChannelInboundEventContext) => void>(),
  mockFormatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
  mockDispatchInboundMessage: vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockResolveFeishuBotName: vi.fn().mockResolvedValue("Peer Bot"),
}));

function inboundContext(): BuiltChannelInboundEventContext {
  return mockBuildChannelInboundEventContext.mock.calls[0]![0];
}

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    formatAgentEnvelope: mockFormatAgentEnvelope,
    resolveEnvelopeFormatOptions: () => ({}),
    buildChannelInboundEventContext: (
      params: Parameters<typeof actual.buildChannelInboundEventContext>[0],
    ) => {
      const context = actual.buildChannelInboundEventContext({
        ...params,
        finalize: (ctx) => ctx,
      });
      mockBuildChannelInboundEventContext(context);
      return context;
    },
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

vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: mockResolveFeishuReasoningPreviewEnabled,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
  listFeishuThreadMessages: mockListFeishuThreadMessages,
}));

vi.mock("./media.js", () => ({
  saveMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  transcribeFirstAudio: mockTranscribeFirstAudio,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: mockMaybeCreateDynamicAgent,
}));

vi.mock("./bot-name.js", () => ({
  resolveFeishuBotName: mockResolveFeishuBotName,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: (params: unknown) =>
      mockResolveConfiguredBindingRoute(params as { route: ResolvedAgentRoute }),
    resolveRuntimeConversationBindingRoute: (params: {
      route: ResolvedAgentRoute;
      conversation: Parameters<
        ReturnType<typeof actual.getSessionBindingService>["resolveByConversation"]
      >[0];
    }) => {
      const bindingRecord = mockResolveBoundConversation(params.conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      mockTouchBinding(bindingRecord.bindingId);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: mockEnsureConfiguredBindingRouteReady,
    getSessionBindingService: () => ({
      resolveByConversation: mockResolveBoundConversation,
      touch: mockTouchBinding,
    }),
  };
});

async function dispatchMessage(params: {
  cfg: ClawdbotConfig;
  currentCfg?: ClawdbotConfig;
  event: FeishuMessageEvent;
  channelRuntime?: PluginRuntime["channel"];
  botOpenId?: string;
  directPreDispatchTarget?: string;
}) {
  const runtime = createRuntimeEnv();
  const feishuConfig = params.cfg.channels?.feishu;
  const cfg =
    feishuConfig?.dmPolicy === "open" && feishuConfig.allowFrom === undefined
      ? ({
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            feishu: {
              ...feishuConfig,
              allowFrom: ["*"],
            },
          },
        } as ClawdbotConfig)
      : params.cfg;
  currentRuntimeConfig = params.currentCfg ?? cfg;
  if (params.directPreDispatchTarget) {
    setFeishuSyntheticDirectPreDispatchTarget(params.event, params.directPreDispatchTarget);
  }
  await handleFeishuMessage({
    cfg,
    event: params.event,
    botOpenId: params.botOpenId,
    runtime,
    channelRuntime: params.channelRuntime,
  });
  return runtime;
}

function receive(
  event: Parameters<typeof createFeishuTestEvent>[0],
  feishu: Parameters<typeof createFeishuTestConfig>[0] = { dmPolicy: "open" },
  base?: Parameters<typeof createFeishuTestConfig>[1],
) {
  return dispatchMessage({
    cfg: createFeishuTestConfig(feishu, base),
    event: createFeishuTestEvent(event),
  });
}

function resetConfiguredBindings() {
  mockResolveConfiguredBindingRoute
    .mockReset()
    .mockImplementation(
      ({
        route,
      }: {
        route: NonNullable<ConfiguredBindingRoute>["route"];
      }): ConfiguredBindingRoute => ({
        bindingResolution: null,
        route,
      }),
    );
  mockEnsureConfiguredBindingRouteReady.mockReset().mockResolvedValue({ ok: true });
  mockResolveBoundConversation.mockReset().mockReturnValue(null);
}

function rejectSenderPermission(msg: string) {
  mockCreateFeishuClient.mockReturnValue({
    contact: {
      user: { get: vi.fn().mockRejectedValue({ response: { data: { code: 99991672, msg } } }) },
    },
  });
}
function historyMessage(
  messageId: string,
  senderId: string,
  senderType: string,
  content: string,
  createTime: number,
) {
  return { messageId, senderId, senderType, content, contentType: "text", createTime };
}

function receiveAcp(
  event: Parameters<typeof createFeishuTestEvent>[0],
  feishu: Parameters<typeof createFeishuTestConfig>[0] = {
    enabled: true,
    allowFrom: ["ou_sender_1"],
    dmPolicy: "open",
  },
) {
  return receive(event, feishu, { session: { mainKey: "main", scope: "per-sender" } });
}
function receiveGroup(
  event: Parameters<typeof createFeishuTestEvent>[0],
  group: NonNullable<Parameters<typeof createFeishuTestConfig>[0]["groups"]>[string] = {},
  feishu: Parameters<typeof createFeishuTestConfig>[0] = {},
  base?: Parameters<typeof createFeishuTestConfig>[1],
) {
  return receive(
    { chatId: "oc-group", chatType: "group", ...event },
    { ...feishu, groups: { "oc-group": { requireMention: false, ...group } } },
    base,
  );
}

describe("handleFeishuMessage ACP routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConfiguredBindings();
    mockTouchBinding.mockReset();
    mockResolveFeishuReasoningPreviewEnabled.mockReset().mockReturnValue(false);
    mockTranscribeFirstAudio.mockReset().mockResolvedValue(undefined);
    mockMaybeCreateDynamicAgent.mockReset().mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    mockResolveFeishuBotName.mockReset().mockResolvedValue("Peer Bot");
    mockResolveAgentRoute.mockReset().mockReturnValue({
      ...createFeishuTestRoute(),
      sessionKey: "agent:main:feishu:direct:ou_sender_1",
    });
    mockSendMessageFeishu.mockReset().mockResolvedValue(sentMessage("reply-msg", "oc_dm"));
    mockCreateFeishuReplyDispatcher.mockReset().mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    });

    setFeishuRuntime(createFeishuBotRuntime());
  });

  it("ensures configured ACP routes for Feishu DMs", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockResolveFeishuReasoningPreviewEnabled.mockReturnValue(true);

    await receiveAcp({
      messageId: "msg-1",
      senderOpenId: "ou_sender_1",
      chatId: "oc_dm",
    });

    expect(mockResolveConfiguredBindingRoute).toHaveBeenCalledTimes(1);
    expect(mockEnsureConfiguredBindingRouteReady).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ allowReasoningPreview: true }),
    );
    expect(mockBuildChannelInboundEventContext).toHaveBeenCalledWith(
      expect.objectContaining({ ConversationRoutePeerId: "ou_sender_1" }),
    );
  });

  it("surfaces configured ACP initialization failures to the Feishu conversation", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
      createConfiguredBindingReadiness(false, "runtime unavailable"),
    );

    await receiveAcp({
      messageId: "msg-2",
      senderOpenId: "ou_sender_1",
      chatId: "oc_dm",
    });

    const message = mockSendMessageFeishu.mock.calls[0]![0];
    expect(message.to).toBe("chat:oc_dm");
    expect(message.text).toContain("runtime unavailable");
  });

  it("surfaces configured ACP initialization failures inside P2P direct-message threads", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
      createConfiguredBindingReadiness(false, "runtime unavailable"),
    );

    await receiveAcp({
      messageId: "msg-thread-child",
      senderOpenId: "ou_sender_1",
      chatId: "oc_dm",
      message: { root_id: "msg-thread-root", thread_id: "omt-acp-dm-thread" },
    });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm",
        replyToMessageId: "msg-thread-root",
        replyInThread: true,
      }),
    );
  });

  it("routes Feishu topic messages through active bound conversations", async () => {
    mockResolveBoundConversation.mockReturnValue(createBoundConversation());

    await receiveAcp(
      {
        messageId: "msg-3",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "hello topic",
        message: { root_id: "om_topic_root" },
      },
      {
        enabled: true,
        allowFrom: ["ou_sender_1"],
        groups: {
          oc_group_chat: {
            allow: true,
            requireMention: false,
            groupSessionScope: "group_topic",
          },
        },
      },
    );

    const conversationRef = mockCallArg<{ channel?: string; conversationId?: string }>(
      mockResolveBoundConversation,
      0,
      0,
    );
    expect(conversationRef.channel).toBe("feishu");
    expect(conversationRef.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(mockTouchBinding).toHaveBeenCalledWith("default:oc_group_chat:topic:om_topic_root");
    expect(mockBuildChannelInboundEventContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ConversationRoutePeerId: "oc_group_chat:topic:om_topic_root",
        ThreadParentId: "oc_group_chat",
      }),
    );
  });

  it("pins shared Feishu DM last-route updates to the configured owner", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async (_params: RecordedSession) => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    runtime.channel.pairing.readAllowFromStore = vi.fn().mockResolvedValue(["ou_sender_2"]);
    mockResolveAgentRoute.mockReturnValue(
      createFeishuTestRoute({ sessionKey: "agent:main:main", lastRoutePolicy: "main" }),
    );
    setFeishuRuntime(runtime);

    await receiveAcp(
      {
        messageId: "msg-dm-last-route-secondary",
        senderOpenId: "ou_sender_2",
        chatId: "oc_dm",
      },
      { enabled: true, allowFrom: ["ou_owner"], dmPolicy: "pairing" },
    );

    const recordParams = recordInboundSession.mock.calls.at(-1)?.[0];
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
      ownerRecipient: "user:ou_owner",
      senderRecipient: "user:ou_sender_2",
    });
    expect(typeof recordParams?.updateLastRoute?.mainDmOwnerPin?.onSkip).toBe("function");
  });

  it("matches Feishu DM owner pins against user_id allowlist entries", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async (_params: RecordedSession) => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue(
      createFeishuTestRoute({ sessionKey: "agent:main:main", lastRoutePolicy: "main" }),
    );
    setFeishuRuntime(runtime);

    await receiveAcp(
      {
        messageId: "msg-dm-last-route-user-id-owner",
        senderOpenId: "ou_owner",
        senderUserId: "user_123",
        chatId: "oc_dm",
      },
      { enabled: true, allowFrom: ["user_123"], dmPolicy: "allowlist" },
    );

    const recordParams = recordInboundSession.mock.calls.at(-1)?.[0];
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
      ownerRecipient: "user:user_123",
      senderRecipient: "user:user_123",
    });
  });

  it("records configured Feishu thread replies with the dispatcher fallback target", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async (_params: RecordedSession) => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue(
      createFeishuTestRoute({
        agentId: "agent-B",
        sessionKey: "agent:agent-B:feishu:group:oc_group_chat",
        mainSessionKey: "agent:agent-B:main",
      }),
    );
    setFeishuRuntime(runtime);

    await receiveAcp(
      {
        messageId: "msg-group-thread-fallback",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "start a thread",
      },
      {
        enabled: true,
        allowFrom: ["ou_sender_1"],
        groups: {
          oc_group_chat: { allow: true, requireMention: false, replyInThread: "enabled" },
        },
      },
    );

    const recordParams = recordInboundSession.mock.calls.at(-1)?.[0];
    expect(recordParams?.updateLastRoute).toMatchObject({
      to: "chat:oc_group_chat",
      threadId: "msg-group-thread-fallback",
    });
  });
});

describe("handleFeishuMessage command authorization", () => {
  let botRuntime: PluginRuntime;
  const mockFinalizeInboundContext = mockBuildChannelInboundEventContext;
  const mockDispatchReplyFromConfig = mockDispatchInboundMessage;
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn<
    PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]
  >(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchReplyFromConfig.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    mockListFeishuThreadMessages.mockReset().mockResolvedValue([]);
    mockReadSessionUpdatedAt.mockReturnValue(undefined);
    mockResolveStorePath.mockReturnValue("/tmp/feishu-sessions.json");
    resetConfiguredBindings();
    mockTouchBinding.mockReset();
    mockTranscribeFirstAudio.mockReset().mockResolvedValue(undefined);
    mockMaybeCreateDynamicAgent.mockReset().mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    mockResolveAgentRoute.mockReturnValue(createFeishuTestRoute());
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    mockEnqueueSystemEvent.mockReset();
    botRuntime = createFeishuBotRuntime({
      system: {
        enqueueSystemEvent: mockEnqueueSystemEvent,
      },
      channel: {
        commands: {
          shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
        },
        pairing: {
          readAllowFromStore: mockReadAllowFromStore,
          upsertPairingRequest: mockUpsertPairingRequest,
          buildPairingReply: mockBuildPairingReply,
        },
      },
    });
    setFeishuRuntime(botRuntime);
  });

  it("routes /compact through the standard reply dispatch path (#90185)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });

    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-compact-command",
        senderOpenId: "ou-command-user",
        text: "/compact",
      }),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchParams = mockCallArg<{
      ctx: {
        CommandAuthorized?: boolean;
        CommandBody?: string;
        BodyForCommands?: string;
        RawBody?: string;
        MessageSid?: string;
      };
    }>(mockDispatchReplyFromConfig, 0, 0);
    expect(dispatchParams.ctx).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/compact",
      BodyForCommands: "/compact",
      RawBody: "/compact",
      MessageSid: "msg-compact-command",
    });
  });

  it("does not send no-visible fallback when send policy denied delivery", async () => {
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      noVisibleReplyFallbackEligible: true,
    });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });

    await receive({
      messageId: "msg-send-policy-deny",
      senderOpenId: "ou-sender",
    });

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("sends no-visible fallback when queued final delivery fails", async () => {
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt: failedFinalReceipt,
    });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });

    await receive({
      messageId: "msg-final-delivery-failed",
      senderOpenId: "ou-sender",
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith("dispatch-complete-no-visible-reply");
  });

  it("routes Feishu groups with exact bindings from the live runtime config", async () => {
    mockResolveAgentRoute.mockImplementation((params) =>
      resolveAgentRoute(params as Parameters<typeof resolveAgentRoute>[0]),
    );

    const startupCfg = createFeishuTestConfig(
      {
        enabled: true,
        groups: { oc_target: { allow: true, requireMention: false } },
      },
      {
        agents: { list: [{ id: "main" }, { id: "oc1" }] },
        bindings: [
          {
            agentId: "oc1",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "group", id: "*" },
            },
          },
        ],
      },
    );
    const liveCfg = {
      ...startupCfg,
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "feishu",
            accountId: "default",
            peer: { kind: "group", id: "oc_target" },
          },
        },
        ...(startupCfg.bindings ?? []),
      ],
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg: startupCfg,
      currentCfg: liveCfg,
      event: createFeishuTestEvent({
        messageId: "msg-group-live-binding",
        senderOpenId: "ou_sender",
        chatId: "oc_target",
        chatType: "group",
      }),
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:feishu:group:oc_target",
      }),
    );
  });

  it("drops a bound DM revoked while sender lookup is pending", async () => {
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn(async () => {
            lookupStarted.resolve();
            await releaseLookup.promise;
            return { data: {} };
          }),
        },
      },
    });
    mockResolveAgentRoute.mockReturnValue({
      ...createFeishuTestRoute(),
      matchedBy: "binding.peer",
    });
    const cfg = createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "test-secret",
      dmPolicy: "open",
      allowFrom: ["*"],
      resolveSenderNames: true,
    });
    const channelRuntime = createFeishuBotRuntime().channel;
    const pending = dispatchMessage({
      cfg,
      channelRuntime,
      event: createFeishuTestEvent({
        messageId: "msg-revoked-during-lookup",
        senderOpenId: "ou_revoked_during_lookup",
      }),
    });
    await lookupStarted.promise;
    currentRuntimeConfig = createFeishuTestConfig({
      ...cfg.channels?.feishu,
      dmPolicy: "disabled",
    });
    releaseLookup.resolve();
    await pending;

    expect(channelRuntime.inbound.run).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge before dynamic creation when current policy requires it", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: { enabled: true },
    });
    const currentCfg = createFeishuTestConfig({
      dmPolicy: "pairing",
      allowFrom: [],
      dynamicAgentCreation: { enabled: true },
    });

    await dispatchMessage({
      cfg,
      currentCfg,
      event: createFeishuTestEvent({ messageId: "msg-refreshed-policy-pairing" }),
    });

    expect(mockMaybeCreateDynamicAgent).not.toHaveBeenCalled();
    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-attacker",
      meta: { name: undefined },
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        accountId: "default",
        text: expect.stringContaining("ABCDEFGH"),
      }),
    );
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("recomputes command authorization against refreshed dynamic-agent config", async () => {
    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: { enabled: true },
    });
    const refreshedCfg = {
      ...cfg,
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;
    mockShouldComputeCommandAuthorized.mockImplementation((_body, candidateCfg) => {
      return candidateCfg === refreshedCfg;
    });
    mockMaybeCreateDynamicAgent.mockResolvedValueOnce({
      created: false,
      updatedCfg: refreshedCfg,
    });

    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-refreshed-command-auth",
        text: "/status",
      }),
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/status", refreshedCfg);
    const context = inboundContext();
    expect(context.CommandAuthorized).toBe(true);
  });

  it("blocks open DMs when a restrictive allowlist does not match", async () => {
    await receive(
      {
        messageId: "msg-auth-bypass-regression",
        text: "/status",
      },
      { dmPolicy: "open", allowFrom: ["ou-admin"] },
      { commands: { useAccessGroups: true } },
    );

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg = createFeishuTestConfig({ dmPolicy: "pairing" });
    const event = createFeishuTestEvent({
      messageId: "msg-pairing-chat-reply",
      sender: { sender_id: { user_id: "u_mobile_only" } },
      chatId: "oc_dm_chat_1",
    });

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    const message = mockSendMessageFeishu.mock.calls[0]![0];
    expect(message.to).toBe("chat:oc_dm_chat_1");
  });

  it("replies to the explicit pre-dispatch target for synthetic DMs", async () => {
    const cfg = createFeishuTestConfig({ dmPolicy: "pairing" });
    const event = createFeishuTestEvent({
      messageId: "synthetic-invite",
      senderOpenId: "ou_synthetic_inviter",
      chatId: "ou_synthetic_inviter",
      text: "join the meeting",
    });
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({
      cfg,
      event,
      directPreDispatchTarget: "user:ou_synthetic_inviter",
    });

    const message = mockSendMessageFeishu.mock.calls[0]![0];
    expect(message.to).toBe("user:ou_synthetic_inviter");
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    await receiveGroup(
      {
        messageId: "msg-group-command-auth",
        text: "@_user_1/status",
        message: { mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot" }] },
      },
      {},
      {},
      { commands: { useAccessGroups: true } },
    );

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const context = inboundContext();
    expect(context.ChatType).toBe("group");
    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith(
      "/status",
      currentRuntimeConfig,
    );
    expect(context.CommandAuthorized).toBe(false);
    expect(context.SenderId).toBe("ou-attacker");
    expect(context.GroupRequireMention).toBe(false);
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    await receiveGroup(
      { messageId: "msg-group-command-fallback", senderOpenId: "ou-admin", text: "/status" },
      {},
      { allowFrom: ["ou-admin"] },
      { commands: { useAccessGroups: true } },
    );

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const context = inboundContext();
    expect(context.ChatType).toBe("group");
    expect(context.CommandAuthorized).toBe(true);
    expect(context.SenderId).toBe("ou-admin");
  });

  it("verifies app-scoped bot mention ids before admitting bot-authored events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const baseFeishuConfig = {
      groupPolicy: "open" as const,
      groups: { "oc-bot-group": { requireMention: true } },
    };
    const createEvent = (messageId: string, mentionedOpenId?: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-peer-bot",
        senderType: "bot",
        chatId: "oc-bot-group",
        chatType: "group",
        text: mentionedOpenId ? "@_openclaw /status" : "/status",
        message: {
          mentions: mentionedOpenId
            ? [{ key: "@_openclaw", id: { open_id: mentionedOpenId }, name: "OpenClaw" }]
            : undefined,
        },
      });

    await dispatchMessage({
      cfg: createFeishuTestConfig(baseFeishuConfig),
      event: createEvent("msg-bot-off", "ou-other-app-openclaw"),
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const getMessage = vi.fn().mockImplementation(({ path }: { path: { message_id: string } }) =>
      Promise.resolve({
        code: 0,
        data: {
          items: [
            {
              mentions:
                path.message_id === "msg-bot-mentioned"
                  ? [
                      {
                        key: "@_openclaw",
                        id: "ou-openclaw",
                        id_type: "open_id",
                        name: "OpenClaw",
                      },
                    ]
                  : [],
            },
          ],
        },
      }),
    );
    mockCreateFeishuClient.mockReturnValue({ im: { message: { get: getMessage } } });

    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: createEvent("msg-bot-unmentioned"),
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const unrelatedMentionEvent = createEvent("msg-bot-other-mention", "ou-other-bot");
    unrelatedMentionEvent.message.mentions![0]!.name = "Other Bot";
    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: unrelatedMentionEvent,
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const admittedEvent = createEvent("msg-bot-mentioned", "ou-other-app-openclaw");
    admittedEvent.message.content = JSON.stringify({ text: "@_openclaw @_alice /status" });
    admittedEvent.message.mentions?.push({
      key: "@_alice",
      id: { open_id: "ou-alice" },
      name: "Alice",
    });
    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: admittedEvent,
      botOpenId: "ou-openclaw",
    });

    expect(mockResolveFeishuBotName).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou-peer-bot" }),
    );
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredMentionTargets: [{ openId: "ou-peer-bot", name: "Peer Bot", key: "" }],
      }),
    );
    const inbound = inboundContext();
    expect(inbound.CommandBody).toBe("/status");
    expect(inbound.BodyForAgent).not.toContain("ou-other-app-openclaw");
    expect(inbound.BodyForAgent).not.toContain("ou-alice");
    expect(getMessage).toHaveBeenCalledTimes(3);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("fails closed for bot ingress when the local bot identity is unavailable", async () => {
    await receive(
      {
        messageId: "msg-bot-no-local-id",
        senderOpenId: "ou-peer-bot",
        senderType: "bot",
        chatId: "oc-bot-group",
        chatType: "group",
        text: "@_openclaw ping",
      },
      {
        allowBots: true,
        groupPolicy: "open",
        groups: { "oc-bot-group": { requireMention: true } },
      },
    );

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses channels.defaults.botLoopProtection for admitted Feishu bot pairs", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const cfg = createFeishuTestConfig(
      {
        allowBots: true,
        groupPolicy: "open",
        groups: { "oc-loop-group": { requireMention: false } },
      },
      {
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 1,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      },
    );
    const event = (messageId: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-loop-peer",
        senderType: "bot",
        chatId: "oc-loop-group",
        chatType: "group",
        text: "@_openclaw ping",
        message: {
          mentions: [{ key: "@_openclaw", id: { open_id: "ou-loop-self" }, name: "OpenClaw" }],
        },
      });

    await dispatchMessage({ cfg, event: event("msg-loop-1"), botOpenId: "ou-loop-self" });
    await dispatchMessage({ cfg, event: event("msg-loop-2"), botOpenId: "ou-loop-self" });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("does not charge an abandoned bot turn twice against the shared conversation budget", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const cfg = createFeishuTestConfig(
      {
        allowBots: true,
        groupPolicy: "open",
        groups: { "oc-burst-retry": { requireMention: false } },
      },
      {
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 100,
              maxConversationBotEvents: 4,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      },
    );
    currentRuntimeConfig = cfg;
    const completed: string[] = [];
    let failBeforeAdoption = true;
    mockDispatchReplyFromConfig.mockImplementation(
      async (params: {
        ctx: { MessageSid: string };
        replyOptions?: { turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> } };
      }) => {
        if (params.ctx.MessageSid === "burst-retry-b1" && failBeforeAdoption) {
          failBeforeAdoption = false;
          throw new Error("transient pre-adoption failure");
        }
        await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
        completed.push(params.ctx.MessageSid);
        return { queuedFinal: false, counts: { final: 1 } };
      },
    );
    const core = getFeishuRuntime().channel;
    let drain = async () => {};
    const channelRuntime: PluginRuntime["channel"] = {
      ...core,
      commands: { ...core.commands, isControlCommandMessage: () => false },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (options) => {
          const debouncer = createInboundDebouncer(options);
          drain = debouncer.drain;
          return debouncer;
        },
      },
    };
    const abandoned = vi.fn();
    const handler = createFeishuMessageReceiveHandler({
      cfg,
      channelRuntime,
      accountId: "default",
      runtime: createRuntimeEnv(),
      chatHistories: new Map(),
      handleMessage: handleFeishuMessage,
      getBotOpenId: () => "ou-burst-self",
      resolveDebounceText: () => "ping",
      hasProcessedMessage: async () => false,
      resolveIngressLifecycle: () => ({
        abortSignal: new AbortController().signal,
        onAdopted: async () => {},
        onDeferred: () => {},
        onAdoptionFinalizing: () => {},
        onAbandoned: abandoned,
      }),
    });
    const receive = async (id: string, sender: string) => {
      await handler(
        createFeishuTestEvent({
          messageId: `burst-retry-${id}`,
          senderOpenId: sender,
          senderType: "bot",
          chatId: "oc-burst-retry",
          chatType: "group",
          text: `@_openclaw ${id}`,
          message: {
            mentions: [{ key: "@_openclaw", id: { open_id: "ou-burst-self" }, name: "OpenClaw" }],
          },
        }),
      );
      await drain();
    };
    await receive("a1", "ou-burst-a");
    await receive("a2", "ou-burst-a");
    await receive("b1", "ou-burst-b");
    expect(completed).toEqual(["burst-retry-a1", "burst-retry-a2"]);
    expect(abandoned).toHaveBeenCalled();
    // The real receive handler releases its logical claim on abandonment.
    await receive("b1", "ou-burst-b");
    await receive("b2", "ou-burst-b");
    expect(completed).toEqual([
      "burst-retry-a1",
      "burst-retry-a2",
      "burst-retry-b1",
      "burst-retry-b2",
    ]);
    await receive("b3", "ou-burst-b");
    expect(completed).toHaveLength(4);
  });

  it("keeps Feishu group policy bound to the chat while preserving speaker identity", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    await receiveGroup(
      { messageId: "msg-group-context-79457", senderOpenId: "ou-allowed" },
      {},
      { groupPolicy: "open", groupSenderAllowFrom: ["ou-allowed"] },
    );

    const finalized = inboundContext();
    expect(finalized.ChatType).toBe("group");
    expect(finalized.From).toBe("feishu:ou-allowed");
    expect(finalized.To).toBe("chat:oc-group");
    expect(finalized.OriginatingChannel).toBe("feishu");
    expect(finalized.OriginatingTo).toBe("chat:oc-group");
    expect(finalized.NativeChannelId).toBe("oc-group");
    expect(finalized.SenderId).toBe("ou-allowed");
    const groupSessionKey = resolveGroupSessionKey(finalized as never);
    if (!groupSessionKey) {
      throw new Error("Expected group session key");
    }
    expect(groupSessionKey.channel).toBe("feishu");
    expect(groupSessionKey.id).toBe("oc-group");
    expect(groupSessionKey.key).toBe("feishu:group:oc-group");
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg: createFeishuTestConfig({
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-global"],
        groups: { "oc-group": { allowFrom: ["ou-group-only"], requireMention: false } },
      }),
      event: createFeishuTestEvent({
        messageId: "msg-per-group-precedence",
        senderOpenId: "ou-global",
        chatId: "oc-group",
        chatType: "group",
      }),
    });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "drops quoted group context from senders outside the group sender allowlist in allowlist mode",
      parentId: "om_parent_blocked",
      messageId: "msg-group-quoted-filter",
      quotedBody: "blocked quoted content",
      contextVisibility: "allowlist" as const,
      expectedBody: undefined,
    },
    {
      name: "keeps quoted group context from non-allowlisted senders in default all mode",
      parentId: "om_parent_visible",
      messageId: "msg-group-quoted-visible",
      quotedBody: "visible quoted content",
      contextVisibility: undefined,
      expectedBody: "visible quoted content",
    },
  ])("$name", async ({ parentId, messageId, quotedBody, contextVisibility, expectedBody }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: parentId,
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: quotedBody,
      contentType: "text",
    });

    await receiveGroup(
      { messageId, senderOpenId: "ou-allowed", message: { parent_id: parentId } },
      {},
      {
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-allowed"],
        ...(contextVisibility ? { contextVisibility } : {}),
      },
    );

    const context = inboundContext();
    expect(context.ReplyToId).toBe(parentId);
    expect(context.SupplementalContext?.quote?.body).toBe(expectedBody);
  });

  it("replaces a failed image download placeholder with an unavailable notice", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired image key"));

    await receive({
      messageId: "msg-image-failed",
      senderOpenId: "ou-sender",
      messageType: "image",
      content: JSON.stringify({ image_key: "expired-image" }),
    });

    const context = inboundContext();
    expect(context.RawBody).toBe("");
    expect(context.CommandBody).toBe("");
    expect(context.BodyForAgent).toContain("[feishu attachment unavailable]");
    expect(context.BodyForAgent).not.toContain("<media:image>");
    expect(context.MediaPath).toBeUndefined();
    expect(context.MediaTypes).toEqual(["image"]);
  });

  it("preserves an audio transcript when the media download fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired audio key"));

    await receive({
      messageId: "msg-audio-failed",
      senderOpenId: "ou-sender",
      messageType: "audio",
      content: JSON.stringify({ file_key: "expired-audio", speech_to_text: "spoken words" }),
    });

    const context = inboundContext();
    expect(context.RawBody).toBe("spoken words");
    expect(context.CommandBody).toBe("spoken words");
    expect(context.BodyForAgent).toContain("spoken words\n\n[feishu attachment unavailable]");
    expect(context.MediaPath).toBeUndefined();
  });

  it("drops the unstable filename annotation when a file download fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired file key"));

    await receive({
      messageId: "msg-file-failed",
      senderOpenId: "ou-sender",
      messageType: "file",
      content: JSON.stringify({ file_key: "expired-file", file_name: "q1.pdf" }),
    });

    const context = inboundContext();
    expect(context.RawBody).toBe("");
    expect(context.CommandBody).toBe("");
    expect(context.BodyForAgent).toContain("[feishu attachment unavailable]");
    expect(context.BodyForAgent).not.toContain("q1.pdf");
    expect(context.BodyForAgent).not.toContain("<media:document>");
    expect(context.MediaPath).toBeUndefined();
    expect(context.MediaTypes).toEqual(["document"]);
  });

  it.each([
    {
      name: "drops group image message when groupPolicy is open but requireMention is explicitly true",
      cfg: createFeishuTestConfig({ groupPolicy: "open", requireMention: true }),
      messageId: "msg-group-image-open-explicit-mention",
      chatId: "oc-group-open",
    },
    {
      name: "drops group image message when groupPolicy is allowlist and requireMention is not set (defaults to true)",
      cfg: createFeishuTestConfig({
        groupPolicy: "allowlist",
        groups: { "oc-allowlist-group": { allow: true } },
      }),
      messageId: "msg-group-image-allowlist",
      chatId: "oc-allowlist-group",
    },
  ])("$name", async ({ cfg, messageId, chatId }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-sender",
        chatId,
        chatType: "group",
        messageType: "image",
        content: JSON.stringify({ image_key: "img_v3_test" }),
      }),
    });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("admits group when chat_id is explicitly configured under groups, even with empty groupAllowFrom (#67687)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    await receive(
      {
        messageId: "msg-explicit-group-67687",
        senderOpenId: "ou-sender",
        chatId: "oc-explicit-group",
        chatType: "group",
        text: "hello bot",
      },
      {
        groupPolicy: "allowlist",
        groups: { "oc-explicit-group": { requireMention: false } },
      },
    );

    expect(mockFinalizeInboundContext).toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not let explicit group config override disabled group policy",
      cfg: createFeishuTestConfig({
        groupPolicy: "disabled",
        groups: { "oc-disabled-policy-group": { requireMention: false } },
      }),
      messageId: "msg-disabled-policy-group",
      chatId: "oc-disabled-policy-group",
      text: "hello bot",
    },
    {
      name: "does not treat wildcard group defaults as allowlist admission",
      cfg: createFeishuTestConfig({
        groupPolicy: "allowlist",
        groups: { "*": { requireMention: false } },
      }),
      messageId: "msg-wildcard-group-default",
      chatId: "oc-wildcard-only",
      text: "hello bot",
    },
    {
      name: "drops message when groupConfig.enabled is false",
      cfg: createFeishuTestConfig({ groups: { "oc-disabled-group": { enabled: false } } }),
      messageId: "msg-disabled-group",
      chatId: "oc-disabled-group",
      text: "hello",
    },
  ])("$name", async ({ cfg, messageId, chatId, text }) => {
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-sender",
        chatId,
        chatType: "group",
        text,
      }),
    });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("marks server-transcribed audio at the reply boundary without local transcription", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      saved: {
        id: "server-voice.ogg",
        path: "/tmp/server-voice.ogg",
        contentType: "audio/ogg",
        size: Buffer.byteLength("server voice"),
      },
    });

    await receive({
      messageId: "msg-audio-server-transcript",
      senderOpenId: "ou-voice",
      messageType: "audio",
      content: JSON.stringify({
        file_key: "file_audio_payload",
        duration: 1200,
        speech_to_text: " supplied transcript ",
      }),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFirstAudio).not.toHaveBeenCalled();
    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    const { ctx } = mockCallArg<{
      ctx: { RawBody: string; media: Array<{ kind: string; transcribed: boolean }> };
    }>(mockDispatchReplyFromConfig, 0, 0);
    expect(ctx.RawBody).toBe("supplied transcript");
    expect(ctx.media).toEqual([
      expect.objectContaining({ path: "/tmp/server-voice.ogg", kind: "audio", transcribed: true }),
    ]);
  });

  it("transcribes inbound audio before building the agent turn", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      saved: {
        id: "inbound-voice.ogg",
        path: "/tmp/inbound-voice.ogg",
        size: Buffer.byteLength("voice"),
        contentType: "audio/ogg",
      },
    });
    mockTranscribeFirstAudio.mockResolvedValueOnce("voice transcript");

    await receive({
      messageId: "msg-audio-inbound",
      senderOpenId: "ou-voice",
      messageType: "audio",
      content: JSON.stringify({ file_key: "file_audio_payload", duration: 1200 }),
    });

    const downloadRequest = mockDownloadMessageResourceFeishu.mock.calls[0]![0];
    expect(downloadRequest.messageId).toBe("msg-audio-inbound");
    expect(downloadRequest.fileKey).toBe("file_audio_payload");
    expect(downloadRequest.type).toBe("file");
    const transcribeRequest = mockTranscribeFirstAudio.mock.calls[0]![0];
    expect(transcribeRequest.ctx?.media).toEqual([
      { path: "/tmp/inbound-voice.ogg", contentType: "audio/ogg", kind: "audio" },
    ]);
    expect(transcribeRequest.ctx?.ChatType).toBe("direct");
    expect(transcribeRequest.cfg?.channels?.feishu?.dmPolicy).toBe("open");
    const finalized = inboundContext();
    expect(finalized.BodyForAgent).toBe(
      "[message_id: msg-audio-inbound]\nou-voice: voice transcript",
    );
    expect(finalized.RawBody).toBe("voice transcript");
    expect(finalized.CommandBody).toBe("voice transcript");
    expect(finalized.Transcript).toBe("voice transcript");
    expect(finalized.MediaPaths).toEqual(["/tmp/inbound-voice.ogg"]);
    expect(finalized.MediaTypes).toEqual(["audio/ogg"]);
    expect(finalized.MediaTranscribedIndexes).toEqual([0]);
    expect(finalized.BodyForAgent).not.toContain("file_audio_payload");
  });

  it("uses media file_key instead of thumbnail image_key for mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await receive({
      messageId: "msg-media-inbound",
      senderOpenId: "ou-sender",
      messageType: "media",
      content: JSON.stringify({
        file_key: "file_media_payload",
        image_key: "img_media_thumb",
        file_name: "mobile.mp4",
      }),
    });

    const downloadRequest = mockDownloadMessageResourceFeishu.mock.calls[0]![0];
    expect(downloadRequest.messageId).toBe("msg-media-inbound");
    expect(downloadRequest.fileKey).toBe("file_media_payload");
    expect(downloadRequest.type).toBe("file");
    expect(downloadRequest).toMatchObject({
      originalFilename: "mobile.mp4",
      maxBytes: expect.any(Number),
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPaths: ["/tmp/inbound-clip.mp4"],
        MediaTypes: ["video/mp4"],
      }),
    );
  });

  it.each([
    { caption: "Compare the attached report", files: ["report.csv"] },
    { caption: "", files: ["report.csv", "notes.csv"] },
  ])("delivers post files with caption '$caption' to agent context", async ({ caption, files }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockImplementation(
      async (params: { fileKey: string; originalFilename?: string }) => ({
        saved: {
          id: params.fileKey,
          path: `/tmp/${params.originalFilename}`,
          size: 20,
          contentType: "text/csv",
        },
      }),
    );
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: `msg-post-files-${files.length}`,
        senderOpenId: "ou-sender",
        messageType: "post",
        content: JSON.stringify({
          content: [[{ tag: "text", text: caption }]],
          files: files.map((fileName, index) => ({
            file_key: `file_report_${index}`,
            file_name: fileName,
          })),
        }),
      }),
    });

    const context = inboundContext();
    if (caption) {
      expect(context.BodyForAgent).toContain(caption);
    }
    expect(context.MediaPaths).toEqual(files.map((fileName) => `/tmp/${fileName}`));
    expect(context.MediaTypes).toEqual(files.map(() => "text/csv"));
  });

  it("delivers unique rich-post attachments in their original mixed-media order", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockImplementation(
      async (params: { fileKey: string; originalFilename?: string; type: "file" | "image" }) => ({
        saved: {
          id: params.originalFilename ?? `${params.fileKey}.png`,
          path: `/tmp/${params.originalFilename ?? `${params.fileKey}.png`}`,
          size: Buffer.byteLength(params.fileKey),
          contentType: params.type === "image" ? "image/png" : "video/mp4",
        },
      }),
    );

    await receive({
      messageId: "msg-post-mixed-attachments",
      senderOpenId: "ou-sender",
      messageType: "post",
      content: JSON.stringify({
        title: "Rich text",
        content: [
          [
            { tag: "text", text: "Urgent", style: ["bold"] },
            { tag: "a", text: "Docs", href: "https://example.com", style: ["italic"] },
            { tag: "text", text: " " },
            { tag: "at", user_name: "Bob", user_id: "ou_bob", style: ["underline"] },
            { tag: "media", file_key: "file_first", file_name: "first.mov" },
            { tag: "img", image_key: "img_shared" },
            { tag: "media", file_key: "file_last", file_name: "last.mov" },
            { tag: "img", image_key: "img_shared" },
            { tag: "media", file_key: "file_first", file_name: "first.mov" },
            { tag: "img", image_key: "file_first" },
          ],
        ],
      }),
    });

    expect(
      mockDownloadMessageResourceFeishu.mock.calls.map((_call, index) => {
        const request = mockDownloadMessageResourceFeishu.mock.calls[index]![0];
        return {
          fileKey: request.fileKey,
          ...(request.originalFilename ? { fileName: request.originalFilename } : {}),
          type: request.type,
        };
      }),
    ).toEqual([
      { fileKey: "file_first", fileName: "first.mov", type: "file" },
      { fileKey: "img_shared", type: "image" },
      { fileKey: "file_last", fileName: "last.mov", type: "file" },
      { fileKey: "file_first", type: "image" },
    ]);

    const context = inboundContext();
    expect(context.MediaPaths).toEqual([
      "/tmp/first.mov",
      "/tmp/img_shared.png",
      "/tmp/last.mov",
      "/tmp/file_first.png",
    ]);
    expect(context.MediaTypes).toEqual(["video/mp4", "image/png", "video/mp4", "image/png"]);
    expect(context.BodyForAgent).toContain("**Urgent***[Docs](https://example.com)* <u>@Bob</u>");
  });

  it("removes failed rich-post media markers while preserving post text", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired image key"));

    await receive({
      messageId: "msg-post-image-failed",
      senderOpenId: "ou-sender",
      messageType: "post",
      content: JSON.stringify({
        title: "Rich text",
        content: [
          [
            { tag: "text", text: "Before " },
            { tag: "img", image_key: "expired-image" },
            { tag: "text", text: " after" },
          ],
        ],
      }),
    });

    const context = inboundContext();
    expect(context.RawBody).toBe("Rich text\n\nBefore  after");
    expect(context.BodyForAgent).toContain(
      "Rich text\n\nBefore  after\n\n[feishu attachment unavailable]",
    );
    expect(context.BodyForAgent).not.toContain("![image]");
    expect(context.MediaPath).toBeUndefined();
  });

  it("parses direct interactive webhook content through the canonical card parser", () => {
    const event = createFeishuTestEvent({
      messageId: "msg-direct-card",
      messageType: "interactive",
      content: JSON.stringify({
        schema: "2.0",
        header: { title: { tag: "plain_text", content: "Direct task" } },
        body: {
          elements: [
            {
              tag: "table",
              columns: [{ name: "status", display_name: "Status" }],
              rows: [{ status: "Open" }],
            },
          ],
        },
      }),
    });

    expect(parseFeishuMessageEvent(event).content).toBe("Direct task\nStatus\nOpen");
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "msg-merge-forward",
      chatId: "oc_group_1",
      contentType: "merge_forward",
      content:
        "[Merged and Forwarded Messages]\n" +
        "- alpha\n" +
        "- Task summary\n" +
        "Task | Owner\n" +
        "Investigate | Alice\n" +
        "- [File: report.pdf]",
    });

    await receive({
      messageId: "msg-merge-forward",
      senderOpenId: "ou-merge",
      messageType: "merge_forward",
      text: "Merged and Forwarded Message",
    });

    expect(mockGetMessageFeishu).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "default",
      messageId: "msg-merge-forward",
    });
    const context = inboundContext();
    expect(context.BodyForAgent).toContain(
      "[Merged and Forwarded Messages]\n" +
        "- alpha\n" +
        "- Task summary\n" +
        "Task | Owner\n" +
        "Investigate | Alice\n" +
        "- [File: report.pdf]",
    );
    expect(context.BodyForAgent).not.toContain("[interactive]");
  });

  it("does not partially parse malformed merge_forward create_time values", () => {
    const items = [
      {
        message_id: "container",
        msg_type: "merge_forward",
        body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
      },
      {
        message_id: "partial",
        upper_message_id: "container",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "partial" }) },
        create_time: "2000ms",
      },
      {
        message_id: "valid",
        upper_message_id: "container",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "valid" }) },
        create_time: "1000",
      },
    ];

    expect(parseMergeForwardContent(items)).toBe(
      "[Merged and Forwarded Messages]\n- partial\n- valid",
    );
  });

  it("bounds merged-forward prompt content and marks truncation", () => {
    const items = [
      {
        message_id: "container",
        msg_type: "merge_forward",
        body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
      },
      {
        message_id: "oversized",
        upper_message_id: "container",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "😀".repeat(20_000) }) },
      },
    ];

    const parsed = parseMergeForwardContent(items);

    expect(parsed.length).toBeLessThanOrEqual(20_000);
    expect(parsed.endsWith("\n... [Merged-forward content truncated]")).toBe(true);
    expect(parsed).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("falls back when shared merge_forward retrieval returns no message", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce(null);

    await receive({
      messageId: "msg-merge-empty",
      senderOpenId: "ou-merge-empty",
      messageType: "merge_forward",
      text: "Merged and Forwarded Message",
    });

    expect(mockGetMessageFeishu).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "default",
      messageId: "msg-merge-empty",
    });
    const context = inboundContext();
    expect(context.BodyForAgent).toContain("[Merged and Forwarded Message - could not fetch]");
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    rejectSenderPermission("permission denied https://open.feishu.cn/app/cli_test");

    await receive(
      {
        messageId: "msg-perm-1",
        senderOpenId: "ou-perm",
        chatId: "oc-group",
        chatType: "group",
        text: "hello group",
      },
      {
        appId: "cli_test",
        appSecret: "sec_test", // pragma: allowlist secret
        groups: { "oc-group": { requireMention: false } },
      },
    );

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = inboundContext();
    expect(context.BodyForAgent).toContain(
      "Permission grant URL: https://open.feishu.cn/app/cli_test",
    );
    expect(context.BodyForAgent).toContain("ou-perm: hello group");
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    rejectSenderPermission(
      "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
    );

    await receive(
      {
        messageId: "msg-perm-scope-1",
        senderOpenId: "ou-perm-scope",
        chatId: "oc-group",
        chatType: "group",
        text: "hello group",
      },
      {
        appId: "cli_scope_bug",
        appSecret: "sec_scope_bug", // pragma: allowlist secret
        groups: { "oc-group": { requireMention: false } },
      },
    );

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = inboundContext();
    expect(context.BodyForAgent).not.toContain("Permission grant URL");
    expect(context.BodyForAgent).toContain("ou-perm-scope: hello group");
  });

  it.each([
    {
      name: "keeps root_id as topic key when root_id and thread_id both exist",
      groupConfig: { groupSessionScope: "group_topic_sender" as const },
      messageId: "msg-scope-topic-thread-id",
      senderOpenId: "ou-topic-user",
      message: { root_id: "om_root_topic", thread_id: "omt_topic_1" },
      expectedPeer: {
        kind: "group" as const,
        id: "oc-group:topic:om_root_topic:sender:ou-topic-user",
      },
      expectedParentPeer: { kind: "group" as const, id: "oc-group" },
    },
    {
      name: "uses thread_id as topic key when root_id is missing",
      groupConfig: {
        groupSessionScope: "group_topic_sender" as const,
        replyInThread: "disabled" as const,
      },
      messageId: "msg-scope-topic-thread-only",
      senderOpenId: "ou-topic-user",
      message: { thread_id: "omt_topic_1" },
      expectedPeer: {
        kind: "group" as const,
        id: "oc-group:topic:omt_topic_1:sender:ou-topic-user",
      },
      expectedParentPeer: { kind: "group" as const, id: "oc-group" },
    },

    {
      name: "maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist",
      accountConfig: { topicSessionMode: "enabled" as const },
      messageId: "msg-legacy-topic-thread-id",
      senderOpenId: "ou-legacy-thread-id",
      message: { root_id: "om_root_legacy", thread_id: "omt_topic_legacy" },
      expectedPeer: { kind: "group" as const, id: "oc-group:topic:om_root_legacy" },
      expectedParentPeer: { kind: "group" as const, id: "oc-group" },
    },

    {
      name: "prefers explicit group scope over explicit account scope",
      accountConfig: { groupSessionScope: "group_topic_sender" as const },
      groupConfig: { groupSessionScope: "group_sender" as const },
      messageId: "msg-group-scope-precedence",
      senderOpenId: "ou-scope-user",
      message: { root_id: "om_root_scope" },
      expectedPeer: { kind: "group" as const, id: "oc-group:sender:ou-scope-user" },
      expectedParentPeer: null,
    },
    {
      name: "prefers explicit account scope over legacy group topic mode",
      accountConfig: { groupSessionScope: "group_sender" as const },
      groupConfig: { topicSessionMode: "enabled" as const },
      messageId: "msg-account-scope-precedence",
      senderOpenId: "ou-scope-user",
      message: { root_id: "om_root_scope" },
      expectedPeer: { kind: "group" as const, id: "oc-group:sender:ou-scope-user" },
      expectedParentPeer: null,
    },
    {
      name: "prefers disabled legacy group topic mode over enabled account topic mode",
      accountConfig: { topicSessionMode: "enabled" as const },
      groupConfig: { topicSessionMode: "disabled" as const },
      messageId: "msg-legacy-scope-precedence",
      senderOpenId: "ou-scope-user",
      message: { root_id: "om_root_scope" },
      expectedPeer: { kind: "group" as const, id: "oc-group" },
      expectedParentPeer: null,
    },
  ])(
    "$name",
    async ({
      accountConfig,
      groupConfig,
      messageId,
      senderOpenId,
      message,
      expectedPeer,
      expectedParentPeer,
    }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      await receiveGroup(
        { messageId, senderOpenId, text: "session scope", message },
        { ...groupConfig },
        { ...accountConfig },
      );

      expectResolvedRouteCall(0, expectedPeer, expectedParentPeer);
      expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
        expect.objectContaining({ replyInThread: true, threadReply: true }),
      );
    },
  );

  it("uses thread_id as the canonical topic key in Feishu topic groups", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": { requireMention: false, groupSessionScope: "group_topic" },
      },
    });
    const topicStarter = createFeishuTestEvent({
      messageId: "om_topic_starter_message",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "topic starter",
      message: { root_id: "omt_topic_1" },
    });
    const topicReply = createFeishuTestEvent({
      messageId: "om_topic_reply_message",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "topic reply",
      message: { root_id: "om_topic_starter_message", thread_id: "omt_topic_1" },
    });

    await dispatchMessage({ cfg, event: topicStarter });
    await dispatchMessage({ cfg, event: topicReply });

    const expectedPeer = { kind: "group" as const, id: "oc-group:topic:omt_topic_1" };
    const expectedParentPeer = { kind: "group" as const, id: "oc-group" };
    expectResolvedRouteCall(0, expectedPeer, expectedParentPeer);
    expectResolvedRouteCall(1, expectedPeer, expectedParentPeer);
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": {
          requireMention: false,
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        },
      },
    });
    const firstTurn = createFeishuTestEvent({
      messageId: "msg-topic-first",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "group",
      text: "create topic",
    });
    const secondTurn = createFeishuTestEvent({
      messageId: "msg-topic-second",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "group",
      text: "follow up in same topic",
      message: { root_id: "msg-topic-first", thread_id: "omt_topic_created" },
    });

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expectResolvedRouteCall(0, { kind: "group", id: "oc-group:topic:msg-topic-first" });
    expectResolvedRouteCall(1, { kind: "group", id: "oc-group:topic:msg-topic-first" });
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyToMessageId: "msg-topic-first",
        rootId: "msg-topic-first",
        typingTargetMessageId: "msg-topic-second",
      }),
    );
  });

  it("hydrates missing native topic thread_id before routing starter events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "msg-native-topic-first",
      chatId: "oc-group",
      chatType: "topic_group",
      content: "topic starter",
      contentType: "text",
      threadId: "omt_native_topic",
    });

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": {
          requireMention: false,
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        },
      },
    });
    const firstTurn = createFeishuTestEvent({
      messageId: "msg-native-topic-first",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "create native topic",
    });
    const secondTurn = createFeishuTestEvent({
      messageId: "msg-native-topic-second",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "follow up in same native topic",
      message: { thread_id: "omt_native_topic" },
    });

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    const getMessageRequest = mockGetMessageFeishu.mock.calls[0]![0];
    expect(getMessageRequest.messageId).toBe("msg-native-topic-first");
    expectResolvedRouteCall(0, { kind: "group", id: "oc-group:topic:omt_native_topic" });
    expectResolvedRouteCall(1, { kind: "group", id: "oc-group:topic:omt_native_topic" });
  });

  it("hydrates synthetic reaction threads from the real message ID in sender-scoped topics", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const reactedMessageId = "om_reacted_deleted_group_topic_sender";
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: reactedMessageId,
      chatId: "oc-group",
      chatType: "topic_group",
      content: "reacted message",
      contentType: "text",
      threadId: "omt_native_reaction",
    });

    await receive(
      {
        messageId: `${reactedMessageId}:reaction:THUMBSUP:synthetic`,
        senderOpenId: "ou-reaction-actor",
        chatId: "oc-group",
        chatType: "topic_group",
        text: `[removed reaction THUMBSUP from message ${reactedMessageId}]`,
        message: {
          reply_target_message_id: reactedMessageId,
          typing_target_message_id: reactedMessageId,
        },
      },
      {
        groups: {
          "oc-group": {
            requireMention: false,
            groupSessionScope: "group_topic_sender",
            replyInThread: "enabled",
          },
        },
      },
    );

    const getMessageRequest = mockGetMessageFeishu.mock.calls[0]![0];
    expect(getMessageRequest.messageId).toBe(reactedMessageId);
    expectResolvedRouteCall(0, {
      kind: "group",
      id: "oc-group:topic:omt_native_reaction:sender:ou-reaction-actor",
    });
  });

  it.each([
    {
      name: "replies to the topic root when handling a message inside an existing topic",
      cfg: createFeishuTestConfig({
        groups: { "oc-group": { requireMention: false, replyInThread: "enabled" } },
      }),
      messageId: "om_child_message",
      senderOpenId: "ou-topic-user",
      rootId: "om_root_topic",
      text: "reply inside topic",
      expected: {
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
        typingTargetMessageId: "om_child_message",
      },
    },
    {
      name: "replies to triggering message in normal group even when root_id is present (#32980)",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group" },
        },
      }),
      messageId: "om_quote_reply",
      senderOpenId: "ou-normal-user",
      rootId: "om_original_msg",
      text: "hello in normal group",
      expected: { replyToMessageId: "om_quote_reply", rootId: "om_original_msg" },
    },
  ])("$name", async ({ cfg, messageId, senderOpenId, rootId, text, expected }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId,
        chatId: "oc-group",
        chatType: "group",
        text,
        message: { root_id: rootId },
      }),
    });

    const dispatcherOptions = mockCreateFeishuReplyDispatcher.mock.calls[0]![0];
    expect(dispatcherOptions).toMatchObject(expected);
    expect(
      vi.mocked(botRuntime.channel.session.recordInboundSession).mock.calls.at(-1)?.[0]
        .updateLastRoute,
    ).toMatchObject({
      to: "chat:oc-group",
      threadId: expected.replyToMessageId,
    });
  });

  it("uses explicit synthetic typing targets without changing reply routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    await receive(
      {
        messageId: "synthetic-reaction-turn",
        senderOpenId: "ou_sender_1",
        chatId: "p2p:ou_sender_1",
        text: "[reacted with THUMBSUP to message om_reply_anchor]",
        message: {
          typing_target_message_id: "om_reacted_message",
          reply_target_message_id: "om_reply_anchor",
        },
      },
      { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
    );

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_anchor",
        typingTargetMessageId: "om_reacted_message",
        chatId: "p2p:ou_sender_1",
        sendTarget: "user:ou_sender_1",
      }),
    );
  });

  it.each([
    {
      name: "keeps P2P replies inside a direct-message thread when Feishu supplies thread_id",
      messageId: "om_dm_thread_child",
      senderOpenId: "ou-thread-dm",
      chatId: "oc-dm-thread",
      rootId: "om_dm_thread_root",
      threadId: "omt_dm_thread",
      text: "hello inside a DM thread",
      expected: {
        replyToMessageId: "om_dm_thread_root",
        rootId: "om_dm_thread_root",
        skipReplyToInMessages: false,
        replyInThread: true,
        threadReply: true,
      },
    },
    {
      name: "keeps root_id-only P2P replies as quote replies outside thread mode",
      messageId: "om_dm_quote_reply",
      senderOpenId: "ou-quote-dm",
      chatId: "oc-dm-quote",
      rootId: "om_dm_quote_root",
      threadId: undefined,
      text: "quoted DM reply",
      expected: {
        replyToMessageId: "om_dm_quote_reply",
        rootId: "om_dm_quote_root",
        skipReplyToInMessages: true,
        replyInThread: false,
        threadReply: false,
      },
    },
  ])("$name", async ({ messageId, senderOpenId, chatId, rootId, threadId, text, expected }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await receive({
      messageId,
      senderOpenId,
      chatId,
      text,
      message: {
        root_id: rootId,
        create_time: "1700000000000",
        ...(threadId ? { thread_id: threadId } : {}),
      },
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(inboundContext().Timestamp).toBe(1700000000000);
    expect(mockFormatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 1700000000000 }),
    );
  });

  it("skips topic thread bootstrap when the thread session already exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadSessionUpdatedAt.mockReturnValue(1710000000000);

    await receiveGroup(
      {
        messageId: "om_topic_followup",
        senderOpenId: "ou-topic-user",
        text: "current turn",
        message: { root_id: "om_topic_root" },
      },
      { groupSessionScope: "group_topic" },
    );

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockListFeishuThreadMessages).not.toHaveBeenCalled();
    const context = inboundContext();
    expect(context.SupplementalContext?.thread?.starterBody).toBeUndefined();
    expect(context.SupplementalContext?.thread?.historyBody).toBeUndefined();
    expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
    expect(context.MessageThreadId).toBe("om_topic_root");
  });

  it("keeps sender-scoped thread history when the inbound event and thread history use different sender ids", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_root",
      chatId: "oc-group",
      content: "root starter",
      contentType: "text",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      historyMessage("om_bot_reply", "app_1", "app", "assistant reply", 1710000000000),
      historyMessage("om_follow_up", "user_topic_1", "user", "follow-up question", 1710000001000),
    ]);

    await receiveGroup(
      {
        messageId: "om_topic_followup_mixed_ids",
        senderOpenId: "ou-topic-user",
        senderUserId: "user_topic_1",
        text: "current turn",
        message: { root_id: "om_topic_root" },
      },
      { groupSessionScope: "group_topic_sender" },
    );

    const context = inboundContext();
    expect(context.SupplementalContext?.thread?.starterBody).toBe("root starter");
    expect(context.SupplementalContext?.thread?.historyBody).toBe(
      "assistant reply\n\nfollow-up question",
    );
    expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
    expect(context.MessageThreadId).toBe("om_topic_root");
  });

  it("filters topic bootstrap context to allowlisted group senders", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_root",
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: "blocked root starter",
      contentType: "text",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      historyMessage("om_blocked_reply", "ou-blocked", "user", "blocked follow-up", 1710000000000),
      historyMessage("om_bot_reply", "app_1", "app", "assistant reply", 1710000001000),
      historyMessage("om_allowed_reply", "ou-allowed", "user", "allowed follow-up", 1710000002000),
    ]);

    await receiveGroup(
      {
        messageId: "om_topic_followup_allowlisted",
        senderOpenId: "ou-allowed",
        text: "current turn",
        message: { root_id: "om_topic_root", thread_id: "omt_topic_1" },
      },
      { groupSessionScope: "group_topic" },
      { groupPolicy: "open", groupSenderAllowFrom: ["ou-allowed"], contextVisibility: "allowlist" },
    );

    const context = inboundContext();
    expect(context.SupplementalContext?.thread?.starterBody).toBe("assistant reply");
    expect(context.SupplementalContext?.thread?.historyBody).toBe(
      "assistant reply\n\nallowed follow-up",
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-image-dedup",
      senderOpenId: "ou-image-dedup",
      messageType: "image",
      content: JSON.stringify({ image_key: "img_dedup_payload" }),
    });

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("dedupes Feishu media by message_id plus file_key", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const createAudioEvent = (fileKey: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId: "msg-audio-reused-id",
        senderOpenId: "ou-audio-dedup",
        messageType: "audio",
        content: JSON.stringify({ file_key: fileKey, duration: 1200 }),
      });

    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_second") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledTimes(2);
    const firstDownloadRequest = mockDownloadMessageResourceFeishu.mock.calls[0]![0];
    expect(firstDownloadRequest.messageId).toBe("msg-audio-reused-id");
    expect(firstDownloadRequest.fileKey).toBe("file_audio_first");
    expect(firstDownloadRequest.type).toBe("file");
    const secondDownloadRequest = mockDownloadMessageResourceFeishu.mock.calls[1]![0];
    expect(secondDownloadRequest.messageId).toBe("msg-audio-reused-id");
    expect(secondDownloadRequest.fileKey).toBe("file_audio_second");
    expect(secondDownloadRequest.type).toBe("file");
  });

  it("skips empty-text messages with no media to prevent blank user turns in session (#74634)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    await receive(
      {
        messageId: "msg-empty-text-74634",
        senderOpenId: "ou-empty-text-sender",
        text: "",
      },
      { dmPolicy: "open", allowFrom: ["*"] },
    );

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("dispatches mention-only group reply with quoted content in requireMention:true group (#90177)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_group_quoted_001",
      chatId: "oc-group-90177",
      content: "parent message with context",
      contentType: "text",
    });

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groups: { "oc-group-90177": { requireMention: true } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-empty-with-quote",
      senderOpenId: "ou-group-sender",
      chatId: "oc-group-90177",
      chatType: "group",
      text: "",
      message: {
        parent_id: "om_group_quoted_001",
        mentions: [
          { key: "@_bot_1", id: { open_id: "ou-bot-90177" }, name: "Bot", tenant_key: "" },
        ],
      },
    });

    await dispatchMessage({ cfg, event, botOpenId: "ou-bot-90177" });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = inboundContext();
    expect(context.Body).toContain("[Replying to:");
    expect(context.Body).toContain("parent message with context");
  });

  it("does not over-fetch quoted message for unmentioned empty reply in requireMention:true group (#90177)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groups: { "oc-group-90177-neg": { requireMention: true } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-unmentioned-empty-quote",
      senderOpenId: "ou-group-sender-neg",
      chatId: "oc-group-90177-neg",
      chatType: "group",
      text: "",
      message: { parent_id: "om_group_quoted_neg" },
    });

    await dispatchMessage({ cfg, event, botOpenId: "ou-bot-90177-neg" });

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});

describe("createFeishuMessageReceiveHandler media dedupe", () => {
  type ReceiveOptions = Parameters<typeof createFeishuMessageReceiveHandler>[0];
  function receiver(
    batchSize: 1 | 2,
    accountId: string,
    resolveDebounceText: ReceiveOptions["resolveDebounceText"],
  ) {
    const handleMessage = vi
      .fn<NonNullable<ReceiveOptions["handleMessage"]>>()
      .mockResolvedValue(undefined);
    const core = {
      channel: {
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => (batchSize === 2 ? 10 : 0)),
          createInboundDebouncer: vi.fn(
            (options: {
              onFlush: (
                entries: FeishuMessageEvent[],
                createFlush: typeof createTestInboundDebounceFlush,
              ) => { completion: Promise<void> };
            }) => {
              const entries: FeishuMessageEvent[] = [];
              return {
                enqueue: async (event: FeishuMessageEvent) => {
                  if (batchSize === 1) {
                    await options.onFlush([event], createTestInboundDebounceFlush).completion;
                  } else {
                    entries.push(event);
                    if (entries.length === batchSize) {
                      await options.onFlush(entries, createTestInboundDebounceFlush).completion;
                    }
                  }
                },
                flushKey: async () => {},
                cancelKey: () => false,
                drain: async () => {},
              };
            },
          ),
        },
        ...(batchSize === 2
          ? { commands: { isControlCommandMessage: vi.fn(() => false) } }
          : { text: { hasControlCommand: vi.fn(() => false) } }),
      },
    } as unknown as PluginRuntime;
    return {
      handleMessage,
      handler: createFeishuMessageReceiveHandler({
        cfg: createFeishuTestConfig({ dmPolicy: "open" }),
        channelRuntime: core.channel,
        accountId,
        chatHistories: new Map(),
        handleMessage,
        resolveDebounceText,
        hasProcessedMessage: vi.fn(async () => false),
      }),
    };
  }

  it("preserves the original dispatch dedupe key when debounce merges text content", async () => {
    const { handler, handleMessage } = receiver(
      2,
      "receive-text-debounce",
      ({ event }) => (JSON.parse(event.message.content) as { text: string }).text,
    );
    const textEvent = (messageId: string, createTime: string, text: string) =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-text-debounce",
        text,
        message: { create_time: createTime },
      });
    const last = textEvent("msg-text-last", "1710000001000", "second");
    await handler(textEvent("msg-text-first", "1710000000000", "first"));
    await handler(last);
    const call = handleMessage.mock.calls[0]![0];
    expect(call.event.message.content).toBe(last.message.content);
    expect(call.preparedContent).toBe("first\nsecond");
    expect(call.messageDedupeKey).toBe(resolveFeishuMessageDedupeKey(last));
    expect(resolveFeishuMessageDedupeKey(call.event)).toBe(call.messageDedupeKey);
  });

  it("keeps same-id media variants distinct at receive time", async () => {
    const { handler, handleMessage } = receiver(1, "receive-media-dedupe", () => "");
    const audioEvent = (fileKey: string) =>
      createFeishuTestEvent({
        messageId: "msg-audio-receive-reused-id",
        senderOpenId: "ou-audio-receive-dedup",
        messageType: "audio",
        content: JSON.stringify({ file_key: fileKey, duration: 1200 }),
      });
    const firstEvent = audioEvent("file_audio_receive_first");
    const secondEvent = audioEvent("file_audio_receive_second");
    await handler(firstEvent);
    await handler(secondEvent);
    await handler(audioEvent("file_audio_receive_first"));
    expect(handleMessage).toHaveBeenCalledTimes(2);
    const firstCall = handleMessage.mock.calls[0]![0];
    const secondCall = handleMessage.mock.calls[1]![0];
    expect(firstCall.event).toEqual(firstEvent);
    expect(firstCall.processingClaim?.commit).toBeTypeOf("function");
    expect(secondCall.event).toEqual(secondEvent);
    expect(secondCall.processingClaim?.commit).toBeTypeOf("function");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
