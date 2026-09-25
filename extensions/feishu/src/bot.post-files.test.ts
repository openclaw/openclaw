import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { resolveConfiguredBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import { feishuDedupeState } from "./dedup-state.js";
import { setFeishuRuntime } from "./runtime.js";

type SaveMessageResourceFeishu = typeof import("./media.js").saveMessageResourceFeishu;
type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;

function savedPostFile(params: Parameters<SaveMessageResourceFeishu>[0]) {
  return {
    saved: {
      id: params.originalFilename ?? params.fileKey,
      path: `/tmp/${params.originalFilename ?? params.fileKey}`,
      size: Buffer.byteLength(params.fileKey),
      contentType: params.originalFilename?.endsWith(".csv") ? "text/csv" : "application/zip",
    },
  };
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
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockListFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  mockDownloadMessageResourceFeishu: vi.fn<SaveMessageResourceFeishu>(async (params) =>
    savedPostFile(params),
  ),
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
  mockEnsureConfiguredBindingRouteReady: vi.fn(async (_params?: unknown) => ({ ok: true })),
  mockResolveBoundConversation: vi.fn((_ref?: unknown) => null),
  mockTouchBinding: vi.fn(),
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
  mockTranscribeFirstAudio: vi.fn(),
  mockMaybeCreateDynamicAgent: vi.fn(),
  mockBuildChannelInboundEventContext: vi.fn(),
  mockFormatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
  mockDispatchInboundMessage: vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockResolveFeishuBotName: vi.fn().mockResolvedValue("Peer Bot"),
}));

const mockFinalizeInboundContext = mockBuildChannelInboundEventContext;
const mockShouldComputeCommandAuthorized = vi.fn(() => false);

let currentRuntimeConfig = {} as ClawdbotConfig;

const resolveAgentRouteMock: PluginRuntime["channel"]["routing"]["resolveAgentRoute"] = (params) =>
  mockResolveAgentRoute(params);
const readSessionUpdatedAtMock: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"] = (
  params,
) => mockReadSessionUpdatedAt(params);
const resolveStorePathMock: PluginRuntime["channel"]["session"]["resolveStorePath"] = (params) =>
  mockResolveStorePath(params);
const resolveEnvelopeFormatOptionsMock = () => ({});
const withReplyDispatcherMock = async ({
  run,
}: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => await run();

function createFeishuBotRuntime(): PluginRuntime {
  const runtime = {
    config: {
      current: vi.fn(() => currentRuntimeConfig),
    },
    channel: {
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
      session: {
        readSessionUpdatedAt: readSessionUpdatedAtMock,
        resolveStorePath: resolveStorePathMock,
        recordInboundSession: vi.fn(async () => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions:
          resolveEnvelopeFormatOptionsMock as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext: mockFinalizeInboundContext as never,
        dispatchReplyFromConfig: mockDispatchInboundMessage,
        withReplyDispatcher: withReplyDispatcherMock as never,
      },
      commands: {
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue(["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      inbound: {
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
            dispatchResult: await mockDispatchInboundMessage({
              ctx: turn.ctxPayload,
              cfg: turn.cfg,
              replyOptions: turn.replyOptions,
            }),
          };
        }),
      },
    },
  } as unknown as PluginRuntime;
  return runtime;
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
    ) =>
      actual.buildChannelInboundEventContext({
        ...params,
        finalize: (ctx) => {
          mockBuildChannelInboundEventContext(ctx);
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

vi.mock("./audio-preflight.runtime.js", () => ({
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
    resolveRuntimeConversationBindingRoute: (params: { route: ResolvedAgentRoute }) => ({
      bindingRecord: null,
      route: params.route,
    }),
    ensureConfiguredBindingRouteReady: (params: unknown) =>
      mockEnsureConfiguredBindingRouteReady(params),
    getSessionBindingService: () => ({
      resolveByConversation: mockResolveBoundConversation,
      touch: mockTouchBinding,
    }),
  };
});

import { handleFeishuMessage } from "./bot.js";
import * as media from "./media.js";

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
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
  currentRuntimeConfig = cfg;
  await handleFeishuMessage({
    cfg,
    event: params.event,
    runtime,
  });
  return runtime;
}

describe("handleFeishuMessage post files[]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuDedupeState.reset();
    // Bind the export resolveFeishuMediaList actually calls. File-local vi.mock
    // factories are not the production binding in the shared extension worker.
    const save = media.saveMessageResourceFeishu;
    if (vi.isMockFunction(save)) {
      save.mockReset().mockImplementation(async (params) => savedPostFile(params));
    } else {
      vi.spyOn(media, "saveMessageResourceFeishu").mockImplementation(async (params) =>
        savedPostFile(params),
      );
    }
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(false);
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    mockListFeishuThreadMessages.mockReset().mockResolvedValue([]);
    mockReadSessionUpdatedAt.mockReturnValue(undefined);
    mockResolveStorePath.mockReturnValue("/tmp/feishu-sessions.json");
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
    mockDispatchInboundMessage.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    setFeishuRuntime(createFeishuBotRuntime());
  });

  it("downloads captioned post files[] into agent context", async () => {
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-post-top-level-files",
        senderOpenId: "ou-sender",
        messageType: "post",
        content: JSON.stringify({
          title: "",
          content: [[{ tag: "text", text: "这是账本" }]],
          content_v2: [[{ tag: "text", text: "这是账本" }]],
          files: [
            {
              file_key: "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
              file_name: "amount-2026-08-01_2026-08-31.csv",
              is_folder: false,
            },
          ],
        }),
      }),
    });

    expect(media.saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-top-level-files",
        fileKey: "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
        type: "file",
        originalFilename: "amount-2026-08-01_2026-08-31.csv",
      }),
    );
    const context = mockCallArg<{
      BodyForAgent?: string;
      MediaPaths?: string[];
      MediaTypes?: string[];
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).toContain("这是账本");
    expect(context.MediaPaths).toEqual(["/tmp/amount-2026-08-01_2026-08-31.csv"]);
    expect(context.MediaTypes).toEqual(["text/csv"]);
  });

  it("downloads multi-file post files[] into agent context", async () => {
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-post-multi-files",
        senderOpenId: "ou-sender",
        messageType: "post",
        content: JSON.stringify({
          title: "",
          content: [[]],
          content_v2: [[]],
          files: [
            {
              file_key: "file_v3_zip_aug",
              file_name: "usage_data_2026-08-01_2026-08-31.zip",
              is_folder: false,
            },
            {
              file_key: "file_v3_zip_sep",
              file_name: "usage_data_2026-09-01_2026-09-18.zip",
              is_folder: false,
            },
          ],
        }),
      }),
    });

    expect(
      vi.mocked(media.saveMessageResourceFeishu).mock.calls.map(([request]) => ({
        fileKey: request.fileKey,
        fileName: request.originalFilename,
        type: request.type,
      })),
    ).toEqual([
      {
        fileKey: "file_v3_zip_aug",
        fileName: "usage_data_2026-08-01_2026-08-31.zip",
        type: "file",
      },
      {
        fileKey: "file_v3_zip_sep",
        fileName: "usage_data_2026-09-01_2026-09-18.zip",
        type: "file",
      },
    ]);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPaths: [
          "/tmp/usage_data_2026-08-01_2026-08-31.zip",
          "/tmp/usage_data_2026-09-01_2026-09-18.zip",
        ],
        MediaTypes: ["application/zip", "application/zip"],
      }),
    );
  });
});
