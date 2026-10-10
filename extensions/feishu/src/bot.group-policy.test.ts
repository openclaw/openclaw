// Feishu tests cover unset groupPolicy allowlist fallback for inbound admission.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { handleFeishuMessage as handleFeishuMessageImpl } from "./bot.js";
import { createFeishuTestConfig, createFeishuTestEvent } from "./bot.test-support.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  builtInboundContextCalls,
  mockCreateFeishuReplyDispatcher,
  mockCreateFeishuClient,
  mockDispatchReply,
  mockRecordInboundSession,
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
  mockRecordInboundSession: vi.fn().mockResolvedValue(undefined),
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

describe("handleFeishuMessage unset groupPolicy", () => {
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockCurrentConfig = vi.fn(() => createFeishuTestConfig({}));
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
        recordInboundSession: mockRecordInboundSession,
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
      reply: {},
      commands: {
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/inbound.txt",
          contentType: "text/plain",
        }),
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
          const turn = await params.adapter.resolveTurn(
            input,
            {
              kind: "message" as const,
              canStartAgentTurn: true,
            },
            {},
          );
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu channel turn plan");
          }
          const routeSessionKey = turn.route.sessionKey;
          await mockRecordInboundSession({
            storePath: mockResolveStorePath(),
            sessionKey: turn.ctxPayload.SessionKey ?? routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          const dispatchResult = await mockDispatchReply({
            ctx: turn.ctxPayload,
            cfg: turn.cfg,
            replyOptions: turn.replyOptions,
          });
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey,
            dispatchResult,
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

  beforeEach(() => {
    vi.clearAllMocks();
    builtInboundContextCalls.length = 0;
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReply.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    mockResolveStorePath.mockReset().mockReturnValue("/tmp/feishu-session-store.json");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-group",
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
    });
    setFeishuRuntime(runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops unlisted group messages when groupPolicy is unset", async () => {
    const cfg = createFeishuTestConfig({});
    const event = createFeishuTestEvent({
      messageId: "msg-unset-group-policy-unlisted",
      chatId: "oc-group",
      chatType: "group",
    });
    const runtime = createRuntimeEnv();

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "ou-bot",
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("group oc-group not in groupAllowFrom (groupPolicy=allowlist)"),
    );
    expect(builtInboundContextCalls).toHaveLength(0);
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });

  it("requires a mention in allowlisted groups when groupPolicy is unset", async () => {
    const cfg = createFeishuTestConfig({ groupAllowFrom: ["oc-group"] });
    const unmentioned = createFeishuTestEvent({
      messageId: "msg-unset-group-policy-unmentioned",
      chatId: "oc-group",
      chatType: "group",
    });
    const runtime = createRuntimeEnv();

    await handleFeishuMessage({
      cfg,
      event: unmentioned,
      botOpenId: "ou-bot",
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("message in group oc-group did not mention bot"),
    );
    expect(builtInboundContextCalls).toHaveLength(0);
    expect(mockDispatchReply).not.toHaveBeenCalled();

    const mentioned = createFeishuTestEvent({
      messageId: "msg-unset-group-policy-mentioned",
      chatId: "oc-group",
      chatType: "group",
      text: "@_user_1 hello",
      message: {
        mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot", tenant_key: "" }],
      },
    });

    await handleFeishuMessage({
      cfg,
      event: mentioned,
      botOpenId: "ou-bot",
      runtime: createRuntimeEnv(),
    });

    expect(builtInboundContextCalls).toHaveLength(1);
    const context = builtInboundContextCalls[0] as {
      ChatType?: string;
      GroupRequireMention?: boolean;
    };
    expect(context.ChatType).toBe("group");
    expect(context.GroupRequireMention).toBe(true);
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
  });
});

describe("resolveFeishuRuntimeGroupPolicy", () => {
  it("fails closed to allowlist when channels.feishu is present but groupPolicy is unset", async () => {
    const { resolveFeishuRuntimeGroupPolicy } = await import("./runtime-group-policy.js");
    const resolved = resolveFeishuRuntimeGroupPolicy({
      cfg: { channels: { feishu: {} } },
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});
