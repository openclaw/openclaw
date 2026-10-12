import {
  buildChannelInboundEventContext,
  type BuiltChannelInboundEventContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { expect, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import type { FeishuProcessingMessage } from "./processing-indicator.js";
import { setFeishuRuntime } from "./runtime.js";

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

export const feishuBotTestState = { currentRuntimeConfig: {} as ClawdbotConfig };

export function sentMessage(
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

export function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const runtime = {
    config: {
      current: vi.fn(() => feishuBotTestState.currentRuntimeConfig),
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

export function mockCallArg<T>(
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

export function expectResolvedRouteCall(
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
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(async () => false),
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

export function inboundContext(): BuiltChannelInboundEventContext {
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

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
  >("openclaw/plugin-sdk/conversation-binding-runtime");
  return {
    ...actual,
    resolveConfiguredBindingRoute: (params: unknown) =>
      mockResolveConfiguredBindingRoute(params as { route: ResolvedAgentRoute }),
    resolveRuntimeConversationBindingRouteAsync: async (params: {
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

export async function dispatchMessage(params: {
  cfg: ClawdbotConfig;
  currentCfg?: ClawdbotConfig;
  event: FeishuMessageEvent;
  channelRuntime?: PluginRuntime["channel"];
  botOpenId?: string;
  turnAdoptionLifecycle?: FeishuIngressLifecycle;
  processingStatus?: FeishuProcessingMessage;
  processingClaim?: Parameters<typeof handleFeishuMessage>[0]["processingClaim"];
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
  feishuBotTestState.currentRuntimeConfig = params.currentCfg ?? cfg;
  await handleFeishuMessage({
    cfg,
    event: params.event,
    botOpenId: params.botOpenId,
    runtime,
    channelRuntime: params.channelRuntime,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
    processingStatus: params.processingStatus,
    processingClaim: params.processingClaim,
  });
  return runtime;
}

export function receive(
  event: Parameters<typeof createFeishuTestEvent>[0],
  feishu: Parameters<typeof createFeishuTestConfig>[0] = { dmPolicy: "open" },
  base?: Parameters<typeof createFeishuTestConfig>[1],
) {
  return dispatchMessage({
    cfg: createFeishuTestConfig(feishu, base),
    event: createFeishuTestEvent(event),
  });
}

export function resetConfiguredBindings() {
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

export const mockFinalizeInboundContext = mockBuildChannelInboundEventContext;
export const mockDispatchReplyFromConfig = mockDispatchInboundMessage;
export const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
export const mockShouldComputeCommandAuthorized = vi.fn<
  PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]
>(() => true);
export const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
export const mockUpsertPairingRequest = vi
  .fn()
  .mockResolvedValue({ code: "ABCDEFGH", created: false });
export const mockBuildPairingReply = vi.fn(() => "Pairing response");
export const mockEnqueueSystemEvent = vi.fn();
export function resetFeishuBotAuthorizationRuntime() {
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
  const botRuntime = createFeishuBotRuntime({
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
  return botRuntime;
}

export {
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
};
