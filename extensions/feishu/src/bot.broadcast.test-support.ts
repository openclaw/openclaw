import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage as handleFeishuMessageImpl } from "./bot.js";
import { withFeishuRuntimeDefaults } from "./bot.test-support.js";
import { feishuDedupeState } from "./dedup-state.js";
import { setFeishuRuntime } from "./runtime.js";

export { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";

const mocks = vi.hoisted(() => {
  const makeReplyDispatcher = () => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
  });
  return {
    builtInboundContextCalls: [] as Array<Record<string, unknown>>,
    createReplyDispatcher: makeReplyDispatcher,
    mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => makeReplyDispatcher()),
    mockCreateFeishuClient: vi.fn(),
    mockDispatchReply: vi.fn().mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
    mockRecordInboundSession: vi.fn().mockResolvedValue(undefined),
    mockResolveAgentRoute: vi.fn(),
    mockResolveStorePath: vi.fn(
      (_store?: unknown, _options?: { agentId?: string }) => "/tmp/feishu-session-store.json",
    ),
  };
});

vi.mock(import("openclaw/plugin-sdk/channel-inbound"), async (importOriginal) => {
  const actual = await importOriginal();
  const finalize: NonNullable<BuildChannelInboundEventContextParams["finalize"]> = (ctx) => {
    mocks.builtInboundContextCalls.push(ctx);
    return ctx;
  };
  function buildContext(
    params: BuildChannelInboundEventContextAsyncParams,
  ): Promise<BuiltChannelInboundEventContext>;
  function buildContext(
    params: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext;
  function buildContext(
    params: BuildChannelInboundEventContextParams &
      Partial<ChannelInboundSupplementalResolutionOptions>,
  ): BuiltChannelInboundEventContext | Promise<BuiltChannelInboundEventContext> {
    return params.resolveSupplementalMedia
      ? actual.buildChannelInboundEventContext({
          ...params,
          finalize,
          resolveSupplementalMedia: true,
        })
      : actual.buildChannelInboundEventContext({ ...params, finalize });
  }
  return {
    ...actual,
    buildChannelInboundEventContext: buildContext,
  };
});

vi.mock(import("openclaw/plugin-sdk/session-store-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveStorePath: mocks.mockResolveStorePath,
}));

// mock-isolation: Capture broadcast delivery without constructing live reply dispatchers.
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mocks.mockCreateFeishuReplyDispatcher,
}));

// mock-isolation: Use fixture chat metadata without opening Feishu clients.
vi.mock("./client.js", () => ({
  createFeishuClient: mocks.mockCreateFeishuClient,
}));

export function setupFeishuBroadcastTestHarness() {
  const mockGetChatInfo = vi.fn();
  const resolvedTurnCalls: ChannelInboundTurnPlan[] = [];
  const mockCurrentConfig = vi.fn(() => createBroadcastConfig());
  const runtimeStub = {
    config: { current: mockCurrentConfig },
    channel: {
      routing: { resolveAgentRoute: mocks.mockResolveAgentRoute },
      session: {
        resolveStorePath: mocks.mockResolveStorePath,
        recordInboundSession: mocks.mockRecordInboundSession,
      },
      commands: { shouldComputeCommandAuthorized: vi.fn(() => false) },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            throw new Error("expected Feishu message input");
          }
          const eventClass = { kind: "message" as const, canStartAgentTurn: true };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu channel turn plan");
          }
          resolvedTurnCalls.push(turn);
          const { route, ctxPayload: ctx, record, cfg, replyOptions, admission } = turn;
          const routeSessionKey = route.sessionKey;
          await mocks.mockRecordInboundSession({
            storePath: mocks.mockResolveStorePath(),
            sessionKey: ctx.SessionKey ?? routeSessionKey,
            ctx,
            groupResolution: record?.groupResolution,
            createIfMissing: record?.createIfMissing,
            updateLastRoute: record?.updateLastRoute,
            onRecordError: record?.onRecordError ?? (() => undefined),
          });
          const dispatchResult = await mocks.mockDispatchReply({ ctx, cfg, replyOptions });
          const dispatched = !(dispatchResult as { undispatched?: boolean }).undispatched;
          if (dispatched && !(dispatchResult as { deferAdoption?: boolean }).deferAdoption) {
            await replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          }
          return {
            admission: admission ?? { kind: "dispatch" as const },
            dispatched,
            ctxPayload: ctx,
            routeSessionKey,
            ...(dispatched ? { dispatchResult } : {}),
          };
        }),
      },
    },
  } as unknown as PluginRuntime;

  async function handleFeishuMessage(params: Parameters<typeof handleFeishuMessageImpl>[0]) {
    mockCurrentConfig.mockReturnValue(withFeishuRuntimeDefaults(params.cfg));
    await handleFeishuMessageImpl(params);
  }

  function createBroadcastConfig(requireMention = true): ClawdbotConfig {
    return {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { entries: { main: {}, susan: {} } },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: { "oc-broadcast-group": { requireMention } },
        },
      },
    };
  }

  function createBroadcastEvent(options: {
    messageId: string;
    text: string;
    botMentioned?: boolean;
  }): FeishuMessageEvent {
    const mentions = options.botMentioned
      ? [{ key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" }]
      : undefined;
    return {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: options.messageId,
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
        ...(mentions ? { mentions } : {}),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    feishuDedupeState.reset();
    mocks.mockDispatchReply
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    mocks.mockResolveStorePath.mockReset().mockReturnValue("/tmp/feishu-session-store.json");
    feishuGroupNameCache.clear();
    mocks.builtInboundContextCalls.length = 0;
    resolvedTurnCalls.length = 0;
    mocks.mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    mocks.mockCreateFeishuReplyDispatcher.mockReturnValue(mocks.createReplyDispatcher());
    mocks.mockCreateFeishuClient.mockReturnValue({
      contact: { user: { get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }) } },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({ code: 0, data: { name: "Broadcast Team" } }),
        },
      },
    });
    setFeishuRuntime(runtimeStub);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    feishuDedupeState.reset();
  });

  return {
    ...mocks,
    createBroadcastConfig,
    createBroadcastEvent,
    handleFeishuMessage,
    mockGetChatInfo,
    resolvedTurnCalls,
    runtimeStub,
  };
}
