import {
  buildChannelInboundEventContext,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage as handleFeishuMessageImpl } from "./bot.js";
import { feishuDedupeState } from "./dedup-state.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  builtInboundContextCalls,
  mockCreateFeishuReplyDispatcher,
  mockCreateFeishuClient,
  mockDispatchReply,
  mockResolveAgentRoute,
  mockResolveStorePath,
} = vi.hoisted(() => ({
  builtInboundContextCalls: [] as Array<Record<string, unknown>>,
  mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
  mockCreateFeishuClient: vi.fn(),
  mockDispatchReply: vi.fn().mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockResolveAgentRoute: vi.fn(),
  mockResolveStorePath: vi.fn(
    (_store?: unknown, _options?: { agentId?: string }) => "/tmp/feishu-session-store.json",
  ),
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

export function createRuntimeEnv() {
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

export function setupFeishuBroadcastTestHarness() {
  const mockGetChatInfo = vi.fn();
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const resolvedTurnCalls: ChannelInboundTurnPlan[] = [];
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });
  const mockCurrentConfig = vi.fn(() => createBroadcastConfig());
  const runtimeStub = {
    config: {
      current: mockCurrentConfig,
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => mockResolveAgentRoute(params),
      },
      session: {
        resolveStorePath: mockResolveStorePath,
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
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
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
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu channel turn plan");
          }
          resolvedTurnCalls.push(turn);
          const routeSessionKey = turn.route.sessionKey;
          const dispatchResult = await mockDispatchReply({
            ctx: turn.ctxPayload,
            cfg: turn.cfg,
            replyOptions: turn.replyOptions,
          });
          const dispatched = !(dispatchResult as { undispatched?: boolean }).undispatched;
          if (dispatched && !(dispatchResult as { deferAdoption?: boolean }).deferAdoption) {
            await turn.replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          }
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched,
            ctxPayload: turn.ctxPayload,
            routeSessionKey,
            ...(dispatched ? { dispatchResult } : {}),
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

  async function handleFeishuMessage(params: Parameters<typeof handleFeishuMessageImpl>[0]) {
    mockCurrentConfig.mockReturnValue(params.cfg);
    await handleFeishuMessageImpl(params);
  }

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
    feishuDedupeState.reset();
    mockDispatchReply.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    mockResolveStorePath.mockReset().mockReturnValue("/tmp/feishu-session-store.json");
    feishuGroupNameCache.clear();
    builtInboundContextCalls.length = 0;
    resolvedTurnCalls.length = 0;
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
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
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

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    feishuDedupeState.reset();
  });

  return {
    builtInboundContextCalls,
    createBroadcastConfig,
    createBroadcastEvent,
    handleFeishuMessage,
    mockCreateFeishuReplyDispatcher,
    mockDispatchReply,
    mockGetChatInfo,
    mockResolveAgentRoute,
    mockResolveStorePath,
    resolvedTurnCalls,
    runtimeStub,
  };
}
