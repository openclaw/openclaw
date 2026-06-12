import type { PreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  createFeishuVcMeetingInvitedHandler,
  resolveVcMeetingInvitedTurn,
} from "./monitor.vc-meeting-invited-handler.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const maybeCreateDynamicAgentMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const conversationBindingMocks = vi.hoisted(() => ({
  resolveConfiguredBindingRoute: vi.fn(({ route }) => ({
    bindingResolution: null,
    route,
  })),
  resolveRuntimeConversationBindingRoute: vi.fn(
    ({ route }: { route: Record<string, unknown>; conversation?: unknown }) => ({
      bindingRecord: null as null | { bindingId: string; targetSessionKey: string },
      route,
      boundSessionKey: undefined as string | undefined,
      boundAgentId: undefined as string | undefined,
    }),
  ),
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
}));
const replyDispatcherMocks = vi.hoisted(() => {
  const markDispatchIdle = vi.fn();
  const dispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
  return {
    dispatcher,
    markDispatchIdle,
    createFeishuReplyDispatcher: vi.fn(() => ({
      dispatcher,
      replyOptions: { sourceReplyDeliveryMode: "automatic" },
      markDispatchIdle,
    })),
  };
});
const dedupMocks = vi.hoisted(() => ({
  claimUnprocessedFeishuMessage: vi.fn(async () => "claimed" as const),
  forgetProcessedFeishuMessage: vi.fn(async () => true),
  recordProcessedFeishuMessage: vi.fn(async () => true),
  releaseFeishuMessageProcessing: vi.fn(),
  warmupDedupFromPluginState: vi.fn(async () => 0),
  hasProcessedFeishuMessage: vi.fn(async () => false),
}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: maybeCreateDynamicAgentMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  resolveConfiguredBindingRoute: conversationBindingMocks.resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute:
    conversationBindingMocks.resolveRuntimeConversationBindingRoute,
  ensureConfiguredBindingRouteReady: conversationBindingMocks.ensureConfiguredBindingRouteReady,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: replyDispatcherMocks.createFeishuReplyDispatcher,
}));

vi.mock("./dedup.js", () => ({
  claimUnprocessedFeishuMessage: dedupMocks.claimUnprocessedFeishuMessage,
  forgetProcessedFeishuMessage: dedupMocks.forgetProcessedFeishuMessage,
  recordProcessedFeishuMessage: dedupMocks.recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing: dedupMocks.releaseFeishuMessageProcessing,
  warmupDedupFromPluginState: dedupMocks.warmupDedupFromPluginState,
  hasProcessedFeishuMessage: dedupMocks.hasProcessedFeishuMessage,
}));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./monitor.transport.js");
  vi.doUnmock("./thread-bindings.js");
  vi.doUnmock("./dynamic-agent.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("openclaw/plugin-sdk/conversation-binding-runtime");
  vi.doUnmock("./reply-dispatcher.js");
  vi.resetModules();
});

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function buildRoute(overrides?: { matchedBy?: "binding.channel" | "default" }) {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:direct:ou_inviter_1",
    mainSessionKey: "agent:main:feishu",
    lastRoutePolicy: "session" as const,
    matchedBy: overrides?.matchedBy ?? ("binding.channel" as const),
  };
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function createTestRuntime(overrides?: {
  readAllowFromStore?: () => Promise<Array<string | number>>;
  upsertPairingRequest?: () => Promise<{ code: string; created: boolean }>;
  resolveAgentRoute?: () => ReturnType<typeof buildRoute>;
}) {
  const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const dispatchReplyFromConfig = vi.fn(async () => ({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  }));
  const withReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      onSettled,
      run,
    }: {
      dispatcher: { sendFinalReply?: (payload: unknown) => boolean };
      onSettled?: () => void;
      run: () => Promise<unknown>;
    }) => {
      expect(dispatcher).toBe(replyDispatcherMocks.dispatcher);
      const result = await run();
      onSettled?.();
      return result;
    },
  );
  const recordInboundSession = vi.fn(async () => {});
  const dispatchPreparedForTest = vi.fn(async (turn: PreparedInboundReply<unknown>) => {
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const dispatchResult = await turn.runDispatch();
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });

  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(overrides?.resolveAgentRoute ?? (() => buildRoute())),
        buildAgentSessionKey: vi.fn(),
      },
      reply: {
        finalizeInboundContext,
        dispatchReplyFromConfig,
        withReplyDispatcher,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
        recordInboundSession,
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
          const turn = await params.adapter.resolveTurn(
            input,
            { kind: "message", canStartAgentTurn: true },
            {},
          );
          if (!("runDispatch" in turn)) {
            throw new Error("vc meeting test runtime only supports prepared turns");
          }
          return await dispatchPreparedForTest(turn as PreparedInboundReply<unknown>);
        }) as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
      pairing: {
        readAllowFromStore: vi.fn(overrides?.readAllowFromStore ?? (async () => [])),
        upsertPairingRequest: vi.fn(
          overrides?.upsertPairingRequest ??
            (async () => ({
              code: "TESTCODE",
              created: true,
            })),
        ),
        buildPairingReply: vi.fn((code: string) => `Pairing code: ${code}`),
      },
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 0),
        createInboundDebouncer: vi.fn(),
      },
    },
    config: {
      replaceConfigFile: vi.fn(async () => {}),
    },
  } as unknown as PluginRuntime;
}

const vcEvent = {
  event_id: "evt_vc_123",
  call_id: "call_vc_123",
  meeting: {
    id: "6911188411934433028",
    meeting_no: "123456789",
    topic: "Weekly sync",
  },
  inviter: {
    id: {
      open_id: "ou_inviter_1",
      user_id: "u_inviter_1",
      union_id: "on_inviter_1",
    },
    user_name: "Alice",
  },
  invite_time: "1712345678",
};

describe("resolveVcMeetingInvitedTurn", () => {
  it("builds a deterministic synthetic turn from the real event fields", () => {
    expect(resolveVcMeetingInvitedTurn(vcEvent)).toEqual({
      turnId: "vc-invited:event:evt_vc_123",
      meetingNo: "123456789",
      topic: "Weekly sync",
      inviteTime: "1712345678",
      inviter: {
        senderId: "ou_inviter_1",
        openId: "ou_inviter_1",
        userId: "u_inviter_1",
        unionId: "on_inviter_1",
        name: "Alice",
      },
      prompt:
        'Use the available tool to join the meeting with meeting number 123456789 immediately. Do not ask for confirmation. If the join tool supports a call_id parameter, pass call_id="call_vc_123"; otherwise join by meeting number only.',
    });
  });

  it("skips malformed events without a meeting number or inviter identity", () => {
    expect(resolveVcMeetingInvitedTurn({ ...vcEvent, meeting: { topic: "Weekly sync" } })).toBe(
      null,
    );
    expect(resolveVcMeetingInvitedTurn({ ...vcEvent, inviter: { id: {} } })).toBe(null);
    expect(
      resolveVcMeetingInvitedTurn({
        ...vcEvent,
        inviter: {
          id: { union_id: "on_inviter_1" },
          user_name: "Alice",
        },
      }),
    ).toBe(null);
  });
});

describe("createFeishuVcMeetingInvitedHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dedupMocks.claimUnprocessedFeishuMessage.mockResolvedValue("claimed");
    dedupMocks.forgetProcessedFeishuMessage.mockResolvedValue(true);
    dedupMocks.recordProcessedFeishuMessage.mockResolvedValue(true);
    dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
    dedupMocks.hasProcessedFeishuMessage.mockResolvedValue(false);
    replyDispatcherMocks.dispatcher.sendToolResult.mockClear();
    replyDispatcherMocks.dispatcher.sendBlockReply.mockClear();
    replyDispatcherMocks.dispatcher.sendFinalReply.mockClear();
    replyDispatcherMocks.dispatcher.waitForIdle.mockClear();
    replyDispatcherMocks.dispatcher.getQueuedCounts.mockClear();
    replyDispatcherMocks.dispatcher.getFailedCounts.mockClear();
    replyDispatcherMocks.dispatcher.markComplete.mockClear();
    replyDispatcherMocks.markDispatchIdle.mockClear();
    replyDispatcherMocks.createFeishuReplyDispatcher.mockClear();
    replyDispatcherMocks.createFeishuReplyDispatcher.mockReturnValue({
      dispatcher: replyDispatcherMocks.dispatcher,
      replyOptions: { sourceReplyDeliveryMode: "automatic" },
      markDispatchIdle: replyDispatcherMocks.markDispatchIdle,
    });
    maybeCreateDynamicAgentMock.mockResolvedValue({ created: false });
    sendMessageFeishuMock.mockResolvedValue({ messageId: "om_pair", chatId: "oc_dm" });
    conversationBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) => ({
      bindingResolution: null,
      route,
    }));
    conversationBindingMocks.resolveRuntimeConversationBindingRoute.mockImplementation(
      ({ route }: { route: Record<string, unknown>; conversation?: unknown }) => ({
        bindingRecord: null,
        route,
        boundSessionKey: undefined,
        boundAgentId: undefined,
      }),
    );
    conversationBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });
  });

  it("dispatches the VC invite through a synthetic no-reply inbound turn", async () => {
    const runtime = createTestRuntime({
      readAllowFromStore: async () => ["ou_inviter_1"],
    });
    setFeishuRuntime(runtime);
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      fireAndForget: false,
    });

    await handler(vcEvent);

    const finalizeInboundContext = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    const withReplyDispatcher = runtime.channel.reply.withReplyDispatcher as ReturnType<
      typeof vi.fn
    >;
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    const recordInboundSession = runtime.channel.session.recordInboundSession as ReturnType<
      typeof vi.fn
    >;
    const inboundRun = runtime.channel.inbound.run as ReturnType<typeof vi.fn>;
    const finalizedContext = mockCallArg(finalizeInboundContext, "finalizeInboundContext") as
      | Record<string, unknown>
      | undefined;

    expect(finalizedContext).toEqual(
      expect.objectContaining({
        From: "feishu:ou_inviter_1",
        To: "user:ou_inviter_1",
        Surface: "feishu-vc-meeting-invited",
        MessageSid: "vc-invited:event:evt_vc_123",
        Timestamp: 1712345678000,
        OriginatingTo: "user:ou_inviter_1",
      }),
    );
    expect(finalizedContext?.BodyForAgent).toContain(
      "Use the available tool to join the meeting with meeting number 123456789 immediately.",
    );
    expect(finalizedContext?.BodyForAgent).toContain(
      'If the join tool supports a call_id parameter, pass call_id="call_vc_123"; otherwise join by meeting number only.',
    );
    const sessionRecord = mockCallArg(recordInboundSession, "recordInboundSession") as
      | { updateLastRoute?: unknown }
      | undefined;
    expect(sessionRecord?.updateLastRoute).toBeUndefined();
    const inboundParams = mockCallArg(inboundRun, "inbound.run") as
      | Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]
      | undefined;
    const adapterInput = await Promise.resolve(inboundParams?.adapter.ingest(inboundParams.raw));
    expect(adapterInput).toEqual(
      expect.objectContaining({
        timestamp: 1712345678000,
      }),
    );
    expect(withReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(replyDispatcherMocks.createFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        accountId: "default",
        chatId: "user:ou_inviter_1",
        messageCreateTimeMs: 1712345678000,
        sessionKey: "agent:main:feishu:direct:ou_inviter_1",
      }),
    );
    expect(replyDispatcherMocks.markDispatchIdle).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockCallArg(dispatchReplyFromConfig, "dispatchReplyFromConfig") as
      | { dispatcher?: unknown; replyOptions?: unknown }
      | undefined;
    expect(dispatchArgs?.dispatcher).toBe(replyDispatcherMocks.dispatcher);
    expect(dispatchArgs?.replyOptions).toEqual({ sourceReplyDeliveryMode: "automatic" });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("preserves bound Feishu DM routes for VC invite turns", async () => {
    const runtime = createTestRuntime({
      readAllowFromStore: async () => ["ou_inviter_1"],
    });
    conversationBindingMocks.resolveRuntimeConversationBindingRoute.mockImplementation(
      ({ route, conversation }) => {
        expect(conversation).toEqual({
          channel: "feishu",
          accountId: "default",
          conversationId: "ou_inviter_1",
        });
        return {
          bindingRecord: {
            bindingId: "bind-feishu-dm",
            targetSessionKey: "agent:bound:feishu:direct:ou_inviter_1",
          },
          boundSessionKey: "agent:bound:feishu:direct:ou_inviter_1",
          boundAgentId: "bound",
          route: {
            ...route,
            agentId: "bound",
            sessionKey: "agent:bound:feishu:direct:ou_inviter_1",
            mainSessionKey: "agent:bound:feishu",
            matchedBy: "binding.channel",
          },
        };
      },
    );
    setFeishuRuntime(runtime);
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      fireAndForget: false,
    });

    await handler(vcEvent);

    expect(conversationBindingMocks.resolveConfiguredBindingRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "ou_inviter_1",
        },
      }),
    );
    const finalizedContext = mockCallArg(
      runtime.channel.reply.finalizeInboundContext as ReturnType<typeof vi.fn>,
      "finalizeInboundContext",
    ) as Record<string, unknown>;
    expect(finalizedContext.SessionKey).toBe("agent:bound:feishu:direct:ou_inviter_1");
    expect(runtime.channel.session.resolveStorePath).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        agentId: "bound",
      }),
    );
    expect(replyDispatcherMocks.createFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "bound",
        chatId: "user:ou_inviter_1",
        sessionKey: "agent:bound:feishu:direct:ou_inviter_1",
      }),
    );
  });

  it("sends a pairing challenge to the inviter when pairing mode blocks dispatch", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      fireAndForget: false,
    });

    await handler(vcEvent);

    expect(runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const pairingReply = mockCallArg(sendMessageFeishuMock, "sendMessageFeishu") as
      | { to?: string; text?: string; accountId?: string }
      | undefined;
    expect(pairingReply?.to).toBe("user:ou_inviter_1");
    expect(pairingReply?.accountId).toBe("default");
    expect(pairingReply?.text).toContain("Pairing code:");
    expect(pairingReply?.text).toContain("TESTCODE");
  });

  it("sends a pairing challenge when the inviter only has user_id", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      fireAndForget: false,
    });

    await handler({
      ...vcEvent,
      inviter: {
        id: { user_id: "u_inviter_1" },
        user_name: "Alice",
      },
    });

    expect(runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const pairingReply = mockCallArg(sendMessageFeishuMock, "sendMessageFeishu") as
      | { to?: string; accountId?: string }
      | undefined;
    expect(pairingReply?.to).toBe("user:u_inviter_1");
    expect(pairingReply?.accountId).toBe("default");
  });

  it("passes the full runtime to dynamic agent creation", async () => {
    const runtime = createTestRuntime({
      readAllowFromStore: async () => ["ou_inviter_1"],
      resolveAgentRoute: () => buildRoute({ matchedBy: "default" }),
    });
    setFeishuRuntime(runtime);
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
            dynamicAgentCreation: {
              enabled: true,
            },
          },
        },
      }),
      accountId: "default",
      fireAndForget: false,
    });

    await handler(vcEvent);

    expect(maybeCreateDynamicAgentMock).toHaveBeenCalledTimes(1);
    const dynamicAgentArgs = mockCallArg(maybeCreateDynamicAgentMock, "maybeCreateDynamicAgent") as
      | {
          runtime?: { config?: { replaceConfigFile?: unknown } };
          senderOpenId?: string;
          configWritesAllowed?: boolean;
        }
      | undefined;
    expect(dynamicAgentArgs?.senderOpenId).toBe("ou_inviter_1");
    expect(dynamicAgentArgs?.configWritesAllowed).toBe(true);
    expect(dynamicAgentArgs?.runtime?.config?.replaceConfigFile).toBe(
      runtime.config.replaceConfigFile,
    );
  });
});

describe("monitorSingleAccount VC event registration", () => {
  beforeEach(() => {
    handlers = {};
    vi.clearAllMocks();
    dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
    createEventDispatcherMock.mockReturnValue({
      register: vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
        handlers = registered;
      }),
    });
  });

  it("registers vc.bot.meeting_invited_v1 with the Feishu event dispatcher", async () => {
    await monitorSingleAccount({
      cfg: buildConfig(),
      account: buildAccount(),
      botOpenIdSource: {
        kind: "prefetched",
        botOpenId: "ou_bot",
        botName: "OpenClaw Bot",
      },
      fireAndForget: false,
      channelRuntime: createTestRuntime().channel,
    });

    expect(typeof handlers["vc.bot.meeting_invited_v1"]).toBe("function");
  });
});
