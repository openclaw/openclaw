import {
  buildChannelInboundEventContext,
  type BuiltChannelInboundEventContext,
} from "openclaw/plugin-sdk/channel-inbound";
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
import { setFeishuRuntime } from "./runtime.js";

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
        readSessionUpdatedAtAsync: async (params: unknown) => mockReadSessionUpdatedAt(params),
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

  it.each([
    {
      messageId: "msg-2",
      message: undefined,
      expected: { text: expect.stringContaining("runtime unavailable") },
    },
    {
      messageId: "msg-thread-child",
      message: { root_id: "msg-thread-root", thread_id: "omt-acp-dm-thread" },
      expected: { replyToMessageId: "msg-thread-root", replyInThread: true },
    },
  ])(
    "surfaces configured ACP initialization failure for $messageId",
    async ({ messageId, message, expected }) => {
      mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
      mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
        createConfiguredBindingReadiness(false, "runtime unavailable"),
      );
      await receiveAcp({ messageId, senderOpenId: "ou_sender_1", chatId: "oc_dm", message });
      expect(mockSendMessageFeishu.mock.calls[0]![0]).toMatchObject({
        to: "chat:oc_dm",
        ...expected,
      });
    },
  );

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

  it.each<
    [
      policy: "pairing" | "allowlist",
      sender: string,
      userId: string | undefined,
      allowed: string,
      ownerRecipient: string,
      senderRecipient: string,
    ]
  >([["pairing", "ou_sender_2", undefined, "ou_owner", "user:ou_owner", "user:ou_sender_2"]])(
    "pins shared Feishu DM last-route updates for %s identities",
    async (dmPolicy, senderOpenId, senderUserId, allowFrom, ownerRecipient, senderRecipient) => {
      const runtime = createFeishuBotRuntime();
      const recordInboundSession = vi.fn(async (_params: RecordedSession) => undefined);
      runtime.channel.session.recordInboundSession = recordInboundSession;
      if (dmPolicy === "pairing") {
        runtime.channel.pairing.readAllowFromStore = vi.fn().mockResolvedValue([senderOpenId]);
      }
      mockResolveAgentRoute.mockReturnValue(
        createFeishuTestRoute({ sessionKey: "agent:main:main", lastRoutePolicy: "main" }),
      );
      setFeishuRuntime(runtime);
      await receiveAcp(
        { messageId: `msg-dm-last-route-${dmPolicy}`, senderOpenId, senderUserId, chatId: "oc_dm" },
        { enabled: true, allowFrom: [allowFrom], dmPolicy },
      );
      const pin = recordInboundSession.mock.calls.at(-1)?.[0].updateLastRoute?.mainDmOwnerPin;
      expect(pin).toMatchObject({ ownerRecipient, senderRecipient });
      expect(typeof pin?.onSkip).toBe("function");
    },
  );
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

  it.each([
    {
      name: "send policy denied delivery",
      result: {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        sendPolicyDenied: true,
        noVisibleReplyFallbackEligible: true,
      },
      fallback: false,
    },
    {
      name: "queued final delivery failed",
      result: {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
        settledReceipt: failedFinalReceipt,
      },
      fallback: true,
    },
  ])("handles no-visible fallback when $name", async ({ name, result, fallback }) => {
    mockDispatchReplyFromConfig.mockResolvedValueOnce(result);
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    await receive({ messageId: `msg-fallback-${name}`, senderOpenId: "ou-sender" });
    if (fallback) {
      expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
        "dispatch-complete-no-visible-reply",
      );
    } else {
      expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
    }
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
        agents: { entries: { main: {}, oc1: {} } },
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
        text: "/compact",
      }),
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/compact", refreshedCfg);
    const context = inboundContext();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/compact",
      BodyForCommands: "/compact",
      RawBody: "/compact",
      MessageSid: "msg-refreshed-command-auth",
    });
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

  it("sends pairing challenges to the chat for user-id-only senders", async () => {
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "pairing" }),
      event: createFeishuTestEvent({
        messageId: "msg-pairing-chat-reply",
        sender: { sender_id: { user_id: "u_mobile_only" } },
        chatId: "oc_dm_chat_1",
      }),
    });
    expect(mockSendMessageFeishu.mock.calls[0]![0].to).toBe("chat:oc_dm_chat_1");
  });

  it.each([
    ["ou-attacker", false],
    ["ou-admin", true],
  ] as const)("computes group command authorization for %s", async (senderOpenId, authorized) => {
    const allowFrom = authorized ? [senderOpenId] : undefined;
    const mentions = authorized
      ? undefined
      : [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot" }];
    const text = authorized ? "/status" : "@_user_1/status";
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(authorized);
    await receiveGroup(
      {
        messageId: `msg-group-command-${senderOpenId}`,
        senderOpenId,
        text,
        message: { mentions },
      },
      {},
      { allowFrom },
      { commands: { useAccessGroups: true } },
    );
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const context = inboundContext();
    expect(context.ChatType).toBe("group");
    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith(
      "/status",
      currentRuntimeConfig,
    );
    expect(context.CommandAuthorized).toBe(authorized);
    expect(context.SenderId).toBe(senderOpenId);
    expect(context.GroupRequireMention).toBe(false);
    expect(context).toMatchObject({
      From: `feishu:${senderOpenId}`,
      To: "chat:oc-group",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc-group",
      NativeChannelId: "oc-group",
    });
    expect(resolveGroupSessionKey(context as never)).toMatchObject({
      channel: "feishu",
      id: "oc-group",
      key: "feishu:group:oc-group",
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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

  it.each([
    {
      type: "audio",
      content: { file_key: "expired-audio", speech_to_text: "spoken words" },
      rawBody: "spoken words",
      body: "spoken words\n\n[feishu attachment unavailable]",
      excluded: [],
      mediaTypes: undefined,
    },
    {
      type: "file",
      content: { file_key: "expired-file", file_name: "q1.pdf" },
      rawBody: "",
      body: "[feishu attachment unavailable]",
      excluded: ["q1.pdf", "<media:document>"],
      mediaTypes: ["document"],
    },
  ])(
    "preserves useful $type content when downloading media fails",
    async ({ type, content, rawBody, body, excluded, mediaTypes }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error(`expired ${type} key`));
      await receive({
        messageId: `msg-${type}-failed`,
        senderOpenId: "ou-sender",
        messageType: type,
        content: JSON.stringify(content),
      });
      const context = inboundContext();
      expect(context.RawBody).toBe(rawBody);
      expect(context.CommandBody).toBe(rawBody);
      expect(context.BodyForAgent).toContain(body);
      for (const marker of excluded) {
        expect(context.BodyForAgent).not.toContain(marker);
      }
      expect(context.MediaPath).toBeUndefined();
      if (mediaTypes) {
        expect(context.MediaTypes).toEqual(mediaTypes);
      }
    },
  );

  it.each<
    [
      name: string,
      config: Parameters<typeof createFeishuTestConfig>[0],
      type: string,
      admitted: boolean,
    ]
  >([
    [
      "default mention",
      { groupPolicy: "allowlist", groups: { "oc-group": { allow: true } } },
      "image",
      false,
    ],
    [
      "explicit group (#67687)",
      { groupPolicy: "allowlist", groups: { "oc-group": { requireMention: false } } },
      "text",
      true,
    ],
    [
      "wildcard defaults",
      { groupPolicy: "allowlist", groups: { "*": { requireMention: false } } },
      "text",
      false,
    ],
    ["disabled group", { groups: { "oc-group": { enabled: false } } }, "text", false],
  ])("enforces group admission: %s", async (name, config, messageType, admitted) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await receive(
      {
        messageId: `msg-group-${name}`,
        senderOpenId: "ou-sender",
        chatId: "oc-group",
        chatType: "group",
        messageType,
        content: JSON.stringify(
          messageType === "image" ? { image_key: "img_v3_test" } : { text: "hello bot" },
        ),
      },
      config,
    );
    if (admitted) {
      expect(mockFinalizeInboundContext).toHaveBeenCalled();
      expect(mockDispatchReplyFromConfig).toHaveBeenCalled();
    } else {
      expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
      expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    }
  });

  it("marks server-transcribed audio before dispatch", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const path = "/tmp/server-voice.ogg";
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      saved: { id: "server-voice.ogg", path, size: 12, contentType: "audio/ogg" },
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
      expect.objectContaining({ path, kind: "audio", transcribed: true }),
    ]);
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

  it.each([{ caption: "Compare the attached report", files: ["report.csv", "notes.csv"] }])(
    "delivers post files with caption '$caption' to agent context",
    async ({ caption, files }) => {
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
    },
  );

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

  it.each([
    {
      messageId: "msg-merge-forward",
      content:
        "[Merged and Forwarded Messages]\n- alpha\n- Task summary\nTask | Owner\nInvestigate | Alice\n- [File: report.pdf]",
    },
    { messageId: "msg-merge-empty", content: null },
  ])(
    "expands merged-forward content or reports a missing message: $messageId",
    async ({ messageId, content }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      mockGetMessageFeishu.mockResolvedValueOnce(
        content === null
          ? null
          : { messageId, chatId: "oc_group_1", contentType: "merge_forward", content },
      );
      await receive({
        messageId,
        senderOpenId: "ou-merge",
        messageType: "merge_forward",
        text: "Merged and Forwarded Message",
      });
      expect(mockGetMessageFeishu).toHaveBeenCalledWith({
        cfg: expect.any(Object),
        accountId: "default",
        messageId,
      });
      expect(inboundContext().BodyForAgent).toContain(
        content ?? "[Merged and Forwarded Message - could not fetch]",
      );
      expect(inboundContext().BodyForAgent).not.toContain("[interactive]");
    },
  );

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

  it.each([
    ["cli_test", "ou-perm", true],
    ["cli_scope_bug", "ou-perm-scope", false],
  ] as const)(
    "dispatches once and filters permission notice for %s",
    async (appId, senderOpenId, visible) => {
      const permission = `permission denied${visible ? "" : ": contact:contact.base:readonly"} https://open.feishu.cn/app/${appId}`;
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      rejectSenderPermission(permission);
      await receiveGroup(
        { messageId: `msg-perm-${appId}`, senderOpenId, text: "hello group" },
        {},
        { appId, appSecret: "sec_test" }, // pragma: allowlist secret
      );
      expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
      const context = inboundContext();
      if (visible) {
        expect(context.BodyForAgent).toContain(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        );
      } else {
        expect(context.BodyForAgent).not.toContain("Permission grant URL");
      }
      expect(context.BodyForAgent).toContain(`${senderOpenId}: hello group`);
    },
  );

  it.each([
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

  it.each([
    {
      chatType: "topic_group" as const,
      senderOpenId: "ou-topic-user",
      replyInThread: undefined,
      first: {
        messageId: "om_topic_starter_message",
        text: "topic starter",
        message: { root_id: "omt_topic_1" },
      },
      second: {
        messageId: "om_topic_reply_message",
        text: "topic reply",
        message: { root_id: "om_topic_starter_message", thread_id: "omt_topic_1" },
      },
      topicId: "omt_topic_1",
    },
    {
      chatType: "group" as const,
      senderOpenId: "ou-topic-init",
      replyInThread: "enabled" as const,
      first: { messageId: "msg-topic-first", text: "create topic", message: undefined },
      second: {
        messageId: "msg-topic-second",
        text: "follow up in same topic",
        message: { root_id: "msg-topic-first", thread_id: "omt_topic_created" },
      },
      topicId: "msg-topic-first",
    },
  ])(
    "keeps the $chatType session key stable across topic creation",
    async ({ chatType, senderOpenId, replyInThread, first, second, topicId }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      const cfg = createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group_topic", replyInThread },
        },
      });
      for (const turn of [first, second]) {
        await dispatchMessage({
          cfg,
          event: createFeishuTestEvent({ ...turn, senderOpenId, chatId: "oc-group", chatType }),
        });
      }
      const peer = { kind: "group" as const, id: `oc-group:topic:${topicId}` };
      expectResolvedRouteCall(0, peer, { kind: "group", id: "oc-group" });
      expectResolvedRouteCall(1, peer, { kind: "group", id: "oc-group" });
      if (chatType === "group") {
        expect(mockCreateFeishuReplyDispatcher).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            replyToMessageId: "msg-topic-first",
            rootId: "msg-topic-first",
            typingTargetMessageId: "msg-topic-second",
          }),
        );
      }
    },
  );

  it.each([
    [false, "msg-native-topic-first", "ou-topic-init", "omt_native_topic", "group_topic"],
    [
      true,
      "om_reacted_deleted_group_topic_sender",
      "ou-reaction-actor",
      "omt_native_reaction",
      "group_topic_sender",
    ],
  ] as const)(
    "hydrates native topic IDs before routing (synthetic=%s)",
    async (synthetic, messageId, senderOpenId, threadId, groupSessionScope) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      mockGetMessageFeishu.mockResolvedValueOnce({
        messageId,
        chatId: "oc-group",
        chatType: "topic_group",
        content: "topic starter",
        contentType: "text",
        threadId,
      });
      const cfg = createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope, replyInThread: "enabled" },
        },
      });
      await dispatchMessage({
        cfg,
        event: createFeishuTestEvent({
          messageId: synthetic ? `${messageId}:reaction:THUMBSUP:synthetic` : messageId,
          senderOpenId,
          chatId: "oc-group",
          chatType: "topic_group",
          text: synthetic
            ? `[removed reaction THUMBSUP from message ${messageId}]`
            : "create native topic",
          message: synthetic
            ? { reply_target_message_id: messageId, typing_target_message_id: messageId }
            : undefined,
        }),
      });
      expect(mockGetMessageFeishu.mock.calls[0]![0].messageId).toBe(messageId);
      const peer = {
        kind: "group" as const,
        id: `oc-group:topic:${threadId}${synthetic ? `:sender:${senderOpenId}` : ""}`,
      };
      expectResolvedRouteCall(0, peer);
      if (!synthetic) {
        await dispatchMessage({
          cfg,
          event: createFeishuTestEvent({
            messageId: "msg-native-topic-second",
            senderOpenId,
            chatId: "oc-group",
            chatType: "topic_group",
            text: "follow up in same native topic",
            message: { thread_id: threadId },
          }),
        });
        expectResolvedRouteCall(1, peer);
      }
    },
  );

  it.each([
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

  it.each([
    {
      mode: "existing",
      senderOpenId: "ou-topic-user",
      senderUserId: undefined,
      scope: "group_topic" as const,
      threadId: undefined,
      starter: undefined,
      history: undefined,
    },
    {
      mode: "sender",
      senderOpenId: "ou-topic-user",
      senderUserId: "user_topic_1",
      scope: "group_topic_sender" as const,
      threadId: undefined,
      starter: "root starter",
      history: "assistant reply\n\nfollow-up question",
    },
    {
      mode: "allowlist",
      senderOpenId: "ou-allowed",
      senderUserId: undefined,
      scope: "group_topic" as const,
      threadId: "omt_topic_1",
      starter: "assistant reply",
      history: "assistant reply\n\nallowed follow-up",
    },
  ])(
    "bootstraps topic history using $mode session policy",
    async ({ mode, senderOpenId, senderUserId, scope, threadId, starter, history }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      if (mode === "existing") {
        mockReadSessionUpdatedAt.mockReturnValue(1710000000000);
      } else {
        mockGetMessageFeishu.mockResolvedValue({
          messageId: "om_topic_root",
          chatId: "oc-group",
          contentType: "text",
          threadId: "omt_topic_1",
          content: mode === "allowlist" ? "blocked root starter" : "root starter",
          ...(mode === "allowlist" ? { senderId: "ou-blocked", senderType: "user" } : {}),
        });
        mockListFeishuThreadMessages.mockResolvedValue(
          mode === "allowlist"
            ? [
                historyMessage(
                  "om_blocked_reply",
                  "ou-blocked",
                  "user",
                  "blocked follow-up",
                  1710000000000,
                ),
                historyMessage("om_bot_reply", "app_1", "app", "assistant reply", 1710000001000),
                historyMessage(
                  "om_allowed_reply",
                  "ou-allowed",
                  "user",
                  "allowed follow-up",
                  1710000002000,
                ),
              ]
            : [
                historyMessage("om_bot_reply", "app_1", "app", "assistant reply", 1710000000000),
                historyMessage(
                  "om_follow_up",
                  "user_topic_1",
                  "user",
                  "follow-up question",
                  1710000001000,
                ),
              ],
        );
      }
      await receiveGroup(
        {
          messageId: `om_topic_followup_${mode}`,
          senderOpenId,
          senderUserId,
          text: "current turn",
          message: { root_id: "om_topic_root", thread_id: threadId },
        },
        { groupSessionScope: scope },
        mode === "allowlist"
          ? {
              groupPolicy: "open",
              groupSenderAllowFrom: ["ou-allowed"],
              contextVisibility: "allowlist",
            }
          : {},
      );
      if (mode === "existing") {
        expect(mockGetMessageFeishu).not.toHaveBeenCalled();
        expect(mockListFeishuThreadMessages).not.toHaveBeenCalled();
      }
      const context = inboundContext();
      expect(context.SupplementalContext?.thread?.starterBody).toBe(starter);
      expect(context.SupplementalContext?.thread?.historyBody).toBe(history);
      expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
      expect(context.MessageThreadId).toBe("om_topic_root");
    },
  );

  it.each([
    {
      type: "image",
      concurrent: true,
      keys: ["img_dedup_payload", "img_dedup_payload"],
      dispatches: 1,
    },
    {
      type: "audio",
      concurrent: false,
      keys: ["file_audio_first", "file_audio_second", "file_audio_first"],
      dispatches: 2,
    },
  ])(
    "dedupes $type messages by ID and media key (concurrent=$concurrent)",
    async ({ type, concurrent, keys, dispatches }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      const messageId = `msg-${type}-dedup`;
      if (type === "audio") {
        mockDownloadMessageResourceFeishu.mockResolvedValue({
          saved: {
            id: "inbound-voice.ogg",
            path: "/tmp/inbound-voice.ogg",
            size: 5,
            contentType: "audio/ogg",
          },
        });
        mockTranscribeFirstAudio.mockResolvedValue("voice transcript");
      }
      const cfg = createFeishuTestConfig({ dmPolicy: "open" });
      const dispatch = (key: string) =>
        dispatchMessage({
          cfg,
          event: createFeishuTestEvent({
            messageId,
            senderOpenId: `ou-${type}-dedup`,
            messageType: type,
            content: JSON.stringify(
              type === "image" ? { image_key: key } : { file_key: key, duration: 1200 },
            ),
          }),
        });
      if (concurrent) {
        await Promise.all(keys.map(dispatch));
      } else {
        for (const key of keys) {
          await dispatch(key);
        }
      }
      expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(dispatches);
      if (!concurrent) {
        const transcribeRequest = mockTranscribeFirstAudio.mock.calls[0]![0];
        expect(transcribeRequest.ctx?.media).toEqual([
          { path: "/tmp/inbound-voice.ogg", contentType: "audio/ogg", kind: "audio" },
        ]);
        expect(transcribeRequest.ctx?.ChatType).toBe("direct");
        expect(transcribeRequest.cfg?.channels?.feishu?.dmPolicy).toBe("open");
        const context = inboundContext();
        expect(context).toMatchObject({
          BodyForAgent: `[message_id: ${messageId}]\nou-audio-dedup: voice transcript`,
          RawBody: "voice transcript",
          CommandBody: "voice transcript",
          Transcript: "voice transcript",
          MediaPaths: ["/tmp/inbound-voice.ogg"],
          MediaTypes: ["audio/ogg"],
          MediaTranscribedIndexes: [0],
        });
        expect(context.BodyForAgent).not.toContain("file_audio_first");
        expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledTimes(2);
        expect(mockDownloadMessageResourceFeishu.mock.calls[0]![0]).toMatchObject({
          messageId,
          fileKey: "file_audio_first",
          type: "file",
        });
        expect(mockDownloadMessageResourceFeishu.mock.calls[1]![0]).toMatchObject({
          messageId,
          fileKey: "file_audio_second",
          type: "file",
        });
      }
    },
  );

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

  it.each([true, false])(
    "fetches quoted context only for admitted mention-only replies (mentioned=%s)",
    async (mentioned) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      if (mentioned) {
        mockGetMessageFeishu.mockResolvedValueOnce({
          messageId: "om_group_quoted_001",
          chatId: "oc-group-90177",
          content: "parent message with context",
          contentType: "text",
        });
      }
      await dispatchMessage({
        cfg: createFeishuTestConfig({
          groupPolicy: "open",
          groups: { "oc-group-90177": { requireMention: true } },
        }),
        event: createFeishuTestEvent({
          messageId: `msg-group-empty-with-quote-${mentioned}`,
          senderOpenId: "ou-group-sender",
          chatId: "oc-group-90177",
          chatType: "group",
          text: "",
          message: {
            parent_id: "om_group_quoted_001",
            mentions: mentioned
              ? [{ key: "@_bot_1", id: { open_id: "ou-bot-90177" }, name: "Bot", tenant_key: "" }]
              : undefined,
          },
        }),
        botOpenId: "ou-bot-90177",
      });
      if (mentioned) {
        expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
        expect(inboundContext().Body).toContain("[Replying to:");
        expect(inboundContext().Body).toContain("parent message with context");
      } else {
        expect(mockGetMessageFeishu).not.toHaveBeenCalled();
        expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
      }
    },
  );
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
