import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
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
  sentMessage,
  withFeishuRuntimeDefaults,
} from "./bot.test-support.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { parseMergeForwardContent } from "./message-content.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const failedFinalReceipt = {
  counts: { final: { failedBeforeSend: 1 } },
  anyVisibleDelivered: false,
} as const;

type RecordedSession = Parameters<PluginRuntime["channel"]["session"]["recordInboundSession"]>[0];
type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>>;
type TestEvent = Parameters<typeof createFeishuTestEvent>[0];
type TestConfig = Parameters<typeof createFeishuTestConfig>[0];
type TestBase = Parameters<typeof createFeishuTestConfig>[1];
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

function unboundRoute({
  route,
}: {
  route: NonNullable<ConfiguredBindingRoute>["route"];
}): ConfiguredBindingRoute {
  return { bindingResolution: null, route };
}

function replyDispatcher(ensureNoVisibleReplyFallback = vi.fn()) {
  return {
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback,
  };
}

function senderClient(get = vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } })) {
  return { contact: { user: { get } } };
}

function savedMedia(id: string, contentType: string, size: number, path = `/tmp/${id}`) {
  return { saved: { id, path, size, contentType } };
}

function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const runtime = {
    config: {
      current: vi.fn(() => currentRuntimeConfig),
    },
    channel: {
      routing: {
        resolveAgentRoute: routeAgent,
      },
      session: {
        readSessionUpdatedAtAsync: async (params: unknown) => readSessionUpdatedAt(params),
        resolveStorePath: storePath,
        recordInboundSession: vi.fn(async () => undefined),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue(["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
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
          const { cfg, route, ctxPayload: ctx, record, replyOptions, admission } = turn;
          await runtime.channel.session.recordInboundSession({
            storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, {
              agentId: route.agentId,
            }),
            sessionKey: ctx.SessionKey ?? route.sessionKey,
            ctx,
            groupResolution: record?.groupResolution,
            createIfMissing: record?.createIfMissing,
            updateLastRoute: record?.updateLastRoute,
            onRecordError: record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: ctx,
            routeSessionKey: route.sessionKey,
            dispatchResult:
              admission?.kind === "observeOnly"
                ? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }
                : await dispatchReply({ ctx, cfg, replyOptions }),
          };
        }),
      },
      ...overrides.channel,
    },
    ...(overrides.system ? { system: overrides.system as PluginRuntime["system"] } : {}),
  } as unknown as PluginRuntime;
  return runtime;
}

type FeishuRoutePeer = { id: string; kind: "direct" | "group" };

function expectResolvedRouteCall(
  callIndex: number,
  peer: FeishuRoutePeer,
  parentPeer?: FeishuRoutePeer | null,
): void {
  expect(routeAgent).toHaveBeenNthCalledWith(
    callIndex + 1,
    expect.objectContaining({ peer, ...(arguments.length >= 3 ? { parentPeer } : {}) }),
  );
}

const {
  createReplyDispatcher,
  sendMessage,
  getMessage,
  listThreadMessages,
  saveMessageResource,
  createClient,
  routeAgent,
  readSessionUpdatedAt,
  storePath,
  configuredRoute,
  ensureBindingReady,
  resolveBinding,
  touchBinding,
  reasoningPreviewEnabled,
  transcribeAudio,
  maybeCreateAgent,
  buildInboundContext,
  formatEnvelope,
  dispatchReply,
  resolveBotName,
} = vi.hoisted(() => ({
  createReplyDispatcher: vi.fn(
    (_params: Parameters<typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher>[0]) =>
      replyDispatcher(),
  ),
  sendMessage: vi
    .fn<typeof import("./send.js").sendMessageFeishu>()
    .mockImplementation(async () => sentMessage("pairing-msg", "oc-dm")),
  getMessage: vi.fn<typeof import("./send.js").getMessageFeishu>().mockResolvedValue(null),
  listThreadMessages: vi.fn().mockResolvedValue([]),
  saveMessageResource: vi
    .fn<typeof import("./media.js").saveMessageResourceFeishu>()
    .mockResolvedValue(savedMedia("inbound-clip.mp4", "video/mp4", Buffer.byteLength("video"))),
  createClient: vi.fn(),
  routeAgent: vi.fn((_params?: unknown) => createFeishuTestRoute()),
  readSessionUpdatedAt: vi.fn((_params?: unknown): number | undefined => undefined),
  storePath: vi.fn((_params?: unknown) => "/tmp/feishu-sessions.json"),
  configuredRoute: vi.fn(unboundRoute),
  ensureBindingReady: vi.fn(async (_params?: unknown): Promise<BindingReadiness> => ({ ok: true })),
  resolveBinding: vi.fn((_ref?: unknown) => null as BoundConversation),
  touchBinding: vi.fn(),
  reasoningPreviewEnabled: vi.fn(async () => false),
  transcribeAudio: vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudio>(),
  maybeCreateAgent: vi.fn(),
  buildInboundContext: vi.fn<(ctx: BuiltChannelInboundEventContext) => void>(),
  formatEnvelope: vi.fn(({ body }: { body: string }) => body),
  dispatchReply: vi.fn().mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  resolveBotName: vi.fn().mockResolvedValue("Peer Bot"),
}));

function inboundContext(): BuiltChannelInboundEventContext {
  return buildInboundContext.mock.calls[0]![0];
}

vi.mock(import("openclaw/plugin-sdk/channel-inbound"), async (importOriginal) => {
  const actual = await importOriginal();
  const capture = (ctx: BuiltChannelInboundEventContext) => {
    buildInboundContext(ctx);
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
    const input = { ...params, finalize: (ctx: Record<string, unknown>) => ctx };
    return params.resolveSupplementalMedia
      ? actual
          .buildChannelInboundEventContext({ ...input, resolveSupplementalMedia: true })
          .then(capture)
      : capture(actual.buildChannelInboundEventContext(input));
  }
  return {
    ...actual,
    formatAgentEnvelope: formatEnvelope,
    resolveEnvelopeFormatOptions: () => ({}),
    buildChannelInboundEventContext: buildContext,
  };
});

vi.mock(import("openclaw/plugin-sdk/session-store-runtime"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveStorePath: storePath };
});

// mock-isolation: Capture reply routing without constructing transport dispatchers.
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: createReplyDispatcher,
}));

// mock-isolation: Pin preview policy independently of operator settings.
vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: reasoningPreviewEnabled,
}));

// mock-isolation: Fixture messages and history replace Feishu network requests.
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessage,
  getMessageFeishu: getMessage,
  listFeishuThreadMessages: listThreadMessages,
}));

// mock-isolation: Fixture saved media avoids downloads and real attachment writes.
vi.mock("./media.js", () => ({
  saveMessageResourceFeishu: saveMessageResource,
}));

vi.mock(import("openclaw/plugin-sdk/media-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeFirstAudio: transcribeAudio,
}));

// mock-isolation: Fixture sender metadata avoids live credential and API access.
vi.mock("./client.js", () => ({
  createFeishuClient: createClient,
}));

// mock-isolation: Exercise routing without creating persistent dynamic agents.
vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: maybeCreateAgent,
}));

// mock-isolation: Pin bot identity without fetching live account metadata.
vi.mock("./bot-name.js", () => ({
  resolveFeishuBotName: resolveBotName,
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>();
  return {
    ...actual,
    resolveConfiguredBindingRoute: (params: unknown) =>
      configuredRoute(params as { route: ResolvedAgentRoute }),
    resolveRuntimeConversationBindingRouteAsync: async (params: {
      route: ResolvedAgentRoute;
      conversation: Parameters<
        ReturnType<typeof actual.getSessionBindingService>["resolveByConversation"]
      >[0];
    }) => {
      const bindingRecord = resolveBinding(params.conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      touchBinding(bindingRecord.bindingId);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        } satisfies ResolvedAgentRoute,
      };
    },
    ensureConfiguredBindingRouteReady: ensureBindingReady,
    getSessionBindingService: () => ({
      resolveByConversation: resolveBinding,
      touch: touchBinding,
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
      ? createFeishuTestConfig({ ...feishuConfig, allowFrom: ["*"] }, params.cfg)
      : params.cfg;
  currentRuntimeConfig = withFeishuRuntimeDefaults(params.currentCfg ?? cfg);
  await handleFeishuMessage({
    cfg,
    event: params.event,
    botOpenId: params.botOpenId,
    runtime,
    channelRuntime: params.channelRuntime,
  });
  return runtime;
}

function receive(event: TestEvent, feishu: TestConfig = { dmPolicy: "open" }, base?: TestBase) {
  return receiveConfigured(event, createFeishuTestConfig(feishu, base));
}

function receiveConfigured(
  event: TestEvent,
  cfg: ClawdbotConfig,
  options: Omit<Parameters<typeof dispatchMessage>[0], "cfg" | "event"> = {},
) {
  return dispatchMessage({ cfg, event: createFeishuTestEvent(event), ...options });
}

function receiveMedia(
  messageId: string,
  messageType: TestEvent["messageType"],
  content: unknown,
  event: Partial<TestEvent> = {},
) {
  return receive({
    senderOpenId: "ou-sender",
    ...event,
    messageId,
    messageType,
    content: JSON.stringify(content),
  });
}

function resetConfiguredBindings() {
  vi.clearAllMocks();
  configuredRoute.mockReset().mockImplementation(unboundRoute);
  ensureBindingReady.mockReset().mockResolvedValue({ ok: true });
  resolveBinding.mockReset().mockReturnValue(null);
  touchBinding.mockReset();
  transcribeAudio.mockReset().mockResolvedValue(undefined);
  maybeCreateAgent
    .mockReset()
    .mockImplementation(async ({ cfg }) => ({ created: false, updatedCfg: cfg }));
}

function rejectSenderPermission(msg: string) {
  createClient.mockReturnValue(
    senderClient(vi.fn().mockRejectedValue({ response: { data: { code: 99991672, msg } } })),
  );
}
function historyMessage(senderId: string, content: string, offset = 0, senderType = "user") {
  return { senderId, senderType, content, createTime: 1710000000000 + offset * 1000 };
}

function mergeForwardItem(
  text: string,
  fields: Partial<Parameters<typeof parseMergeForwardContent>[0][number]> & {
    message_id?: string;
  } = {},
) {
  return {
    msg_type: "text",
    upper_message_id: "container",
    body: { content: JSON.stringify({ text }) },
    ...fields,
  };
}

function expectDispatcher(options: Partial<Parameters<typeof createReplyDispatcher>[0]>) {
  expect(createReplyDispatcher).toHaveBeenCalledWith(expect.objectContaining(options));
}

function expectContext(context: Partial<BuiltChannelInboundEventContext>) {
  expect(buildInboundContext).toHaveBeenCalledWith(expect.objectContaining(context));
}

function groupConfig(
  group: NonNullable<TestConfig["groups"]>[string] = {},
  feishu: TestConfig = {},
  base?: TestBase,
  chatId = "oc-group",
) {
  return createFeishuTestConfig(
    { ...feishu, groups: { [chatId]: { requireMention: false, ...group } } },
    base,
  );
}

function receiveAcp(
  event: TestEvent,
  feishu: TestConfig = {
    enabled: true,
    allowFrom: ["ou_sender_1"],
    dmPolicy: "open",
  },
) {
  return receive(event, feishu, { session: { mainKey: "main", scope: "per-sender" } });
}
function receiveGroup(
  event: TestEvent,
  group: NonNullable<TestConfig["groups"]>[string] = {},
  feishu: TestConfig = {},
  base?: TestBase,
  options?: Parameters<typeof receiveConfigured>[2],
) {
  return receiveConfigured(
    { chatId: "oc-group", chatType: "group", ...event },
    groupConfig(group, feishu, base, event.chatId),
    options,
  );
}

describe("handleFeishuMessage ACP routing", () => {
  beforeEach(() => {
    resetConfiguredBindings();
    reasoningPreviewEnabled.mockReset().mockResolvedValue(false);
    resolveBotName.mockReset().mockResolvedValue("Peer Bot");
    routeAgent.mockReset().mockReturnValue({
      ...createFeishuTestRoute(),
      sessionKey: "agent:main:feishu:direct:ou_sender_1",
    });
    sendMessage.mockReset().mockResolvedValue(sentMessage("reply-msg", "oc_dm"));
    createReplyDispatcher.mockReset().mockReturnValue(replyDispatcher());

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
      configuredRoute.mockReturnValue(createConfiguredFeishuRoute());
      ensureBindingReady.mockResolvedValue(
        createConfiguredBindingReadiness(false, "runtime unavailable"),
      );
      await receiveAcp({ messageId, senderOpenId: "ou_sender_1", chatId: "oc_dm", message });
      expect(sendMessage.mock.calls[0]![0]).toMatchObject({
        to: "chat:oc_dm",
        ...expected,
      });
    },
  );

  it("routes Feishu topic messages through active bound conversations", async () => {
    resolveBinding.mockReturnValue(createBoundConversation());

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

    expect(resolveBinding.mock.calls[0]?.[0]).toMatchObject({
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root",
    });
    expect(touchBinding).toHaveBeenCalledWith("default:oc_group_chat:topic:om_topic_root");
    expectContext({
      ConversationRoutePeerId: "oc_group_chat:topic:om_topic_root",
      ThreadParentId: "oc_group_chat",
    });
  });

  it("pins shared Feishu DM last-route updates for pairing identities", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async (_params: RecordedSession) => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    runtime.channel.pairing.readAllowFromStore = vi.fn().mockResolvedValue(["ou_sender_2"]);
    routeAgent.mockReturnValue(
      createFeishuTestRoute({ sessionKey: "agent:main:main", lastRoutePolicy: "main" }),
    );
    setFeishuRuntime(runtime);
    await receiveAcp(
      {
        messageId: "msg-dm-last-route-pairing",
        senderOpenId: "ou_sender_2",
        chatId: "oc_dm",
      },
      { enabled: true, allowFrom: ["ou_owner"], dmPolicy: "pairing" },
    );
    const pin = recordInboundSession.mock.calls.at(-1)?.[0].updateLastRoute?.mainDmOwnerPin;
    expect(pin).toMatchObject({
      ownerRecipient: "user:ou_owner",
      senderRecipient: "user:ou_sender_2",
    });
    expect(typeof pin?.onSkip).toBe("function");
  });
});

describe("handleFeishuMessage command authorization", () => {
  let botRuntime: PluginRuntime;
  const computeCommandAccess = vi.fn<
    PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]
  >(() => true);
  const readAllowFrom = vi.fn().mockResolvedValue([]);
  const upsertPairing = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const enqueueSystemEvent = vi.fn();
  beforeEach(() => {
    resetConfiguredBindings();
    dispatchReply.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    computeCommandAccess.mockReset().mockReturnValue(false);
    getMessage.mockReset().mockResolvedValue(null);
    listThreadMessages.mockReset().mockResolvedValue([]);
    readSessionUpdatedAt.mockReturnValue(undefined);
    storePath.mockReturnValue("/tmp/feishu-sessions.json");
    routeAgent.mockReturnValue(createFeishuTestRoute());
    createClient.mockReturnValue(senderClient());
    enqueueSystemEvent.mockReset();
    botRuntime = createFeishuBotRuntime({
      system: {
        enqueueSystemEvent,
      },
      channel: {
        commands: {
          shouldComputeCommandAuthorized: computeCommandAccess,
        },
        pairing: {
          readAllowFromStore: readAllowFrom,
          upsertPairingRequest: upsertPairing,
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
    computeCommandAccess.mockReturnValue(true);
    dispatchReply.mockResolvedValueOnce(result);
    const ensureNoVisibleReplyFallback = vi.fn();
    createReplyDispatcher.mockReturnValueOnce(replyDispatcher(ensureNoVisibleReplyFallback));
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
    computeCommandAccess.mockReturnValue(true);
    routeAgent.mockImplementation((params) =>
      resolveAgentRoute(params as Parameters<typeof resolveAgentRoute>[0]),
    );

    const binding = (agentId: string, id: string) => ({
      agentId,
      match: { channel: "feishu", accountId: "default", peer: { kind: "group" as const, id } },
    });
    const startupCfg = groupConfig(
      { allow: true },
      { enabled: true },
      {
        agents: { entries: { main: {}, oc1: {} } },
        bindings: [binding("oc1", "*")],
      },
      "oc_target",
    );
    const liveCfg = {
      ...startupCfg,
      bindings: [binding("main", "oc_target"), ...(startupCfg.bindings ?? [])],
    } as ClawdbotConfig;

    await receiveConfigured(
      {
        messageId: "msg-group-live-binding",
        senderOpenId: "ou_sender",
        chatId: "oc_target",
        chatType: "group",
      },
      startupCfg,
      { currentCfg: liveCfg },
    );

    expectDispatcher({ agentId: "main", sessionKey: "agent:main:feishu:group:oc_target" });
  });

  it("drops a bound DM revoked while sender lookup is pending", async () => {
    computeCommandAccess.mockReturnValue(true);
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    createClient.mockReturnValue(
      senderClient(
        vi.fn(async () => {
          lookupStarted.resolve();
          await releaseLookup.promise;
          return { data: {} };
        }),
      ),
    );
    routeAgent.mockReturnValue({
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
    const pending = receiveConfigured(
      {
        messageId: "msg-revoked-during-lookup",
        senderOpenId: "ou_revoked_during_lookup",
      },
      cfg,
      { channelRuntime },
    );
    await lookupStarted.promise;
    currentRuntimeConfig = createFeishuTestConfig({
      ...cfg.channels?.feishu,
      dmPolicy: "disabled",
    });
    releaseLookup.resolve();
    await pending;

    expect(channelRuntime.inbound.run).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge before dynamic creation when current policy requires it", async () => {
    readAllowFrom.mockResolvedValue([]);
    upsertPairing.mockResolvedValue({ code: "ABCDEFGH", created: true });

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

    await receiveConfigured({ messageId: "msg-refreshed-policy-pairing" }, cfg, { currentCfg });

    expect(maybeCreateAgent).not.toHaveBeenCalled();
    expect(upsertPairing).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-attacker",
      meta: { name: undefined },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        accountId: "default",
        text: expect.stringContaining("ABCDEFGH"),
      }),
    );
    expect(dispatchReply).not.toHaveBeenCalled();
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
    computeCommandAccess.mockImplementation((_body, candidateCfg) => {
      return candidateCfg === refreshedCfg;
    });
    maybeCreateAgent.mockResolvedValueOnce({
      created: false,
      updatedCfg: refreshedCfg,
    });

    await receiveConfigured(
      {
        messageId: "msg-refreshed-command-auth",
        text: "/compact",
      },
      cfg,
    );

    expectDispatcher({ cfg: refreshedCfg });
    expect(dispatchReply).toHaveBeenCalledWith(expect.objectContaining({ cfg: refreshedCfg }));
    expect(computeCommandAccess).toHaveBeenCalledWith("/compact", refreshedCfg);
    const context = inboundContext();
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/compact",
      BodyForCommands: "/compact",
      RawBody: "/compact",
      MessageSid: "msg-refreshed-command-auth",
    });
  });

  it("blocks open DMs when a restrictive allowlist does not match", async () => {
    computeCommandAccess.mockReturnValue(true);
    await receive(
      {
        messageId: "msg-auth-bypass-regression",
        text: "/status",
      },
      { dmPolicy: "open", allowFrom: ["ou-admin"] },
      { commands: { useAccessGroups: true } },
    );

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(buildInboundContext).not.toHaveBeenCalled();
  });

  it("sends pairing challenges to the chat for user-id-only senders", async () => {
    computeCommandAccess.mockReturnValue(true);
    readAllowFrom.mockResolvedValue([]);
    upsertPairing.mockResolvedValue({ code: "ABCDEFGH", created: true });
    await receive(
      {
        messageId: "msg-pairing-chat-reply",
        sender: { sender_id: { user_id: "u_mobile_only" } },
        chatId: "oc_dm_chat_1",
      },
      { dmPolicy: "pairing" },
    );
    expect(sendMessage.mock.calls[0]![0].to).toBe("chat:oc_dm_chat_1");
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
    computeCommandAccess.mockReturnValue(true);
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
    const context = inboundContext();
    expect(computeCommandAccess).toHaveBeenCalledWith("/status", currentRuntimeConfig);
    expect(context).toMatchObject({
      ChatType: "group",
      CommandAuthorized: authorized,
      SenderId: senderOpenId,
      GroupRequireMention: false,
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
    expect(dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("verifies app-scoped bot mention ids before admitting bot-authored events", async () => {
    const dispatchBot = (event: FeishuMessageEvent, allowBots = true) =>
      dispatchMessage({
        cfg: groupConfig(
          { requireMention: true },
          { groupPolicy: "open", ...(allowBots ? { allowBots } : {}) },
          undefined,
          "oc-bot-group",
        ),
        event,
        botOpenId: "ou-openclaw",
      });
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

    await dispatchBot(createEvent("msg-bot-off", "ou-other-app-openclaw"), false);
    expect(dispatchReply).not.toHaveBeenCalled();

    const verifiedMention = {
      key: "@_openclaw",
      id: "ou-openclaw",
      id_type: "open_id",
      name: "OpenClaw",
    };
    const verifiedMessageLookup = vi.fn(async ({ path }: { path: { message_id: string } }) => ({
      code: 0,
      data: {
        items: [
          {
            mentions: path.message_id === "msg-bot-mentioned" ? [verifiedMention] : [],
          },
        ],
      },
    }));
    createClient.mockReturnValue({ im: { message: { get: verifiedMessageLookup } } });

    await dispatchBot(createEvent("msg-bot-unmentioned"));
    expect(dispatchReply).not.toHaveBeenCalled();

    const unrelatedMentionEvent = createEvent("msg-bot-other-mention", "ou-other-bot");
    unrelatedMentionEvent.message.mentions![0]!.name = "Other Bot";
    await dispatchBot(unrelatedMentionEvent);
    expect(dispatchReply).not.toHaveBeenCalled();

    const admittedEvent = createEvent("msg-bot-mentioned", "ou-other-app-openclaw");
    admittedEvent.message.content = JSON.stringify({ text: "@_openclaw @_alice /status" });
    admittedEvent.message.mentions?.push({
      key: "@_alice",
      id: { open_id: "ou-alice" },
      name: "Alice",
    });
    await dispatchBot(admittedEvent);

    expect(resolveBotName).toHaveBeenCalledWith(expect.objectContaining({ openId: "ou-peer-bot" }));
    expectDispatcher({
      requiredMentionTargets: [{ openId: "ou-peer-bot", name: "Peer Bot", key: "" }],
    });
    const inbound = inboundContext();
    expect(inbound.CommandBody).toBe("/status");
    expect(inbound.BodyForAgent).not.toContain("ou-other-app-openclaw");
    expect(inbound.BodyForAgent).not.toContain("ou-alice");
    expect(verifiedMessageLookup).toHaveBeenCalledTimes(3);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("uses channels.defaults.botLoopProtection for admitted Feishu bot pairs", async () => {
    const cfg = groupConfig(
      {},
      { allowBots: true, groupPolicy: "open" },
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
      "oc-loop-group",
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

    expect(dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    await receiveGroup(
      { messageId: "msg-per-group-precedence", senderOpenId: "ou-global" },
      { allowFrom: ["ou-group-only"] },
      {
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-global"],
      },
    );

    expect(buildInboundContext).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("drops quoted group context from senders outside the group sender allowlist in allowlist mode", async () => {
    const parentId = "om_parent_blocked";
    getMessage.mockResolvedValueOnce({
      messageId: parentId,
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: "blocked quoted content",
      contentType: "text",
    });

    await receiveGroup(
      {
        messageId: "msg-group-quoted-filter",
        senderOpenId: "ou-allowed",
        message: { parent_id: parentId },
      },
      {},
      {
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-allowed"],
        contextVisibility: "allowlist",
      },
    );

    const context = inboundContext();
    expect(context.ReplyToId).toBe(parentId);
    expect(context.SupplementalContext?.quote?.body).toBeUndefined();
  });

  it.each([
    [
      "audio",
      { file_key: "expired-audio", speech_to_text: "spoken words" },
      "spoken words",
      "spoken words\n\n[feishu attachment unavailable]",
      [],
      undefined,
    ],
    [
      "file",
      { file_key: "expired-file", file_name: "q1.pdf" },
      "",
      "[feishu attachment unavailable]",
      ["q1.pdf", "<media:document>"],
      ["document"],
    ],
  ] as const)(
    "preserves useful %s content when downloading media fails",
    async (type, content, rawBody, body, excluded, mediaTypes) => {
      saveMessageResource.mockRejectedValueOnce(new Error(`expired ${type} key`));
      await receiveMedia(`msg-${type}-failed`, type, content);
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
      expect(buildInboundContext).toHaveBeenCalled();
      expect(dispatchReply).toHaveBeenCalled();
    } else {
      expect(buildInboundContext).not.toHaveBeenCalled();
      expect(dispatchReply).not.toHaveBeenCalled();
    }
  });

  it("marks server-transcribed audio before dispatch", async () => {
    const path = "/tmp/server-voice.ogg";
    saveMessageResource.mockResolvedValueOnce(savedMedia("server-voice.ogg", "audio/ogg", 12));
    await receiveMedia(
      "msg-audio-server-transcript",
      "audio",
      {
        file_key: "file_audio_payload",
        duration: 1200,
        speech_to_text: " supplied transcript ",
      },
      { senderOpenId: "ou-voice" },
    );
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(dispatchReply.mock.calls[0]![0]).toMatchObject({
      ctx: {
        RawBody: "supplied transcript",
        media: [{ path, kind: "audio", transcribed: true }],
      },
    });
  });

  it("uses media file_key instead of thumbnail image_key for mobile video download", async () => {
    await receiveMedia("msg-media-inbound", "media", {
      file_key: "file_media_payload",
      image_key: "img_media_thumb",
      file_name: "mobile.mp4",
    });

    const downloadRequest = saveMessageResource.mock.calls[0]![0];
    expect(downloadRequest).toMatchObject({
      messageId: "msg-media-inbound",
      fileKey: "file_media_payload",
      type: "file",
      originalFilename: "mobile.mp4",
      maxBytes: expect.any(Number),
    });
    expectContext({
      MediaPaths: ["/tmp/inbound-clip.mp4"],
      MediaTypes: ["video/mp4"],
    });
  });

  it("delivers post files with caption 'Compare the attached report' to agent context", async () => {
    const caption = "Compare the attached report";
    const files = ["report.csv", "notes.csv"];
    saveMessageResource.mockImplementation(
      async (params: { fileKey: string; originalFilename?: string }) =>
        savedMedia(params.fileKey, "text/csv", 20, `/tmp/${params.originalFilename}`),
    );
    await receiveMedia(`msg-post-files-${files.length}`, "post", {
      content: [[{ tag: "text", text: caption }]],
      files: files.map((fileName, index) => ({
        file_key: `file_report_${index}`,
        file_name: fileName,
      })),
    });

    const context = inboundContext();
    expect(context.BodyForAgent).toContain(caption);
    expect(context.MediaPaths).toEqual(files.map((fileName) => `/tmp/${fileName}`));
    expect(context.MediaTypes).toEqual(files.map(() => "text/csv"));
  });

  it("delivers unique rich-post attachments in their original mixed-media order", async () => {
    saveMessageResource.mockImplementation(
      async (params: { fileKey: string; originalFilename?: string; type: "file" | "image" }) =>
        savedMedia(
          params.originalFilename ?? `${params.fileKey}.png`,
          params.type === "image" ? "image/png" : "video/mp4",
          Buffer.byteLength(params.fileKey),
        ),
    );

    await receiveMedia("msg-post-mixed-attachments", "post", {
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
    });

    expect(
      saveMessageResource.mock.calls.map(([{ fileKey, originalFilename, type }]) => [
        fileKey,
        originalFilename,
        type,
      ]),
    ).toEqual([
      ["file_first", "first.mov", "file"],
      ["img_shared", undefined, "image"],
      ["file_last", "last.mov", "file"],
      ["file_first", undefined, "image"],
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
      getMessage.mockResolvedValueOnce(
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
      expect(getMessage).toHaveBeenCalledWith({
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

  it("does not partially parse malformed merge_forward create_time values", async () => {
    const items = [
      mergeForwardItem("Merged and Forwarded Message", {
        message_id: "container",
        msg_type: "merge_forward",
        upper_message_id: undefined,
      }),
      mergeForwardItem("partial", { message_id: "partial", create_time: "2000ms" }),
      mergeForwardItem("valid", { message_id: "valid", create_time: "1000" }),
      mergeForwardItem("out of range", {
        create_time: "8640000000000001",
        sender: { id: "ou_original" },
      }),
    ];

    expect(await parseMergeForwardContent(items)).toBe(
      "[Merged and Forwarded Messages]\n- partial\n- [1970-01-01T00:00:01.000Z] valid\n- ou_original: out of range",
    );
  });

  it("bounds merged-forward prompt content and marks truncation", async () => {
    const items = [
      mergeForwardItem("Merged and Forwarded Message", {
        message_id: "container",
        msg_type: "merge_forward",
        upper_message_id: undefined,
      }),
      mergeForwardItem("😀".repeat(20_000), { message_id: "oversized" }),
    ];

    const parsed = await parseMergeForwardContent(items);

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
      rejectSenderPermission(permission);
      await receiveGroup(
        { messageId: `msg-perm-${appId}`, senderOpenId, text: "hello group" },
        {},
        { appId, appSecret: "sec_test" }, // pragma: allowlist secret
      );
      expect(dispatchReply).toHaveBeenCalledTimes(1);
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
    [
      "legacy topic mode uses root_id before thread_id",
      { topicSessionMode: "enabled" },
      {},
      { root_id: "om_root_legacy", thread_id: "omt_topic_legacy" },
      "oc-group:topic:om_root_legacy",
      { kind: "group", id: "oc-group" },
    ],
    [
      "group scope overrides account scope",
      { groupSessionScope: "group_topic_sender" },
      { groupSessionScope: "group_sender" },
      { root_id: "om_root_scope" },
      "oc-group:sender:ou-scope-user",
      null,
    ],
  ] as const)("%s", async (name, accountConfig, groupOverrides, message, id, parentPeer) => {
    await receiveGroup(
      { messageId: `msg-${name}`, senderOpenId: "ou-scope-user", message },
      groupOverrides,
      accountConfig,
    );

    expectResolvedRouteCall(0, { kind: "group", id }, parentPeer);
    expectDispatcher({ replyInThread: true, threadReply: true });
  });

  it.each([
    [
      "topic_group",
      { root_id: "omt_topic_1" },
      { root_id: "msg-topic-first", thread_id: "omt_topic_1" },
      "omt_topic_1",
    ],
    [
      "group",
      undefined,
      { root_id: "msg-topic-first", thread_id: "omt_topic_created" },
      "msg-topic-first",
    ],
  ] as const)(
    "keeps the %s session key stable across topic creation",
    async (chatType, first, second, topicId) => {
      const firstMessageId = `msg-topic-first-${chatType}`;
      const secondMessageId = `msg-topic-second-${chatType}`;
      const expectedTopicId = chatType === "group" ? firstMessageId : topicId;
      const cfg = groupConfig({
        groupSessionScope: "group_topic",
        replyInThread: chatType === "group" ? "enabled" : undefined,
      });
      for (const [messageId, message] of [
        [firstMessageId, first],
        [secondMessageId, { ...second, root_id: firstMessageId }],
      ] as const) {
        await receiveConfigured(
          {
            messageId,
            message,
            chatId: "oc-group",
            chatType,
            senderOpenId: "ou-topic-user",
          },
          cfg,
        );
      }
      const peer = { kind: "group" as const, id: `oc-group:topic:${expectedTopicId}` };
      expectResolvedRouteCall(0, peer, { kind: "group", id: "oc-group" });
      expectResolvedRouteCall(1, peer, { kind: "group", id: "oc-group" });
      if (chatType === "group") {
        expect(createReplyDispatcher).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            replyToMessageId: firstMessageId,
            rootId: firstMessageId,
            typingTargetMessageId: secondMessageId,
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
      getMessage.mockResolvedValueOnce({
        messageId,
        chatId: "oc-group",
        chatType: "topic_group",
        content: "topic starter",
        contentType: "text",
        threadId,
      });
      const cfg = groupConfig({ groupSessionScope, replyInThread: "enabled" });
      await receiveConfigured(
        {
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
        },
        cfg,
      );
      expect(getMessage.mock.calls[0]![0].messageId).toBe(messageId);
      const peer = {
        kind: "group" as const,
        id: `oc-group:topic:${threadId}${synthetic ? `:sender:${senderOpenId}` : ""}`,
      };
      expectResolvedRouteCall(0, peer);
      if (!synthetic) {
        await receiveConfigured(
          {
            messageId: "msg-native-topic-second",
            senderOpenId,
            chatId: "oc-group",
            chatType: "topic_group",
            text: "follow up in same native topic",
            message: { thread_id: threadId },
          },
          cfg,
        );
        expectResolvedRouteCall(1, peer);
      }
    },
  );

  it("replies to triggering message in normal group even when root_id is present (#32980)", async () => {
    await receiveGroup(
      {
        messageId: "om_quote_reply",
        senderOpenId: "ou-normal-user",
        text: "hello in normal group",
        message: { root_id: "om_original_msg" },
      },
      { groupSessionScope: "group" },
    );

    const dispatcherOptions = createReplyDispatcher.mock.calls[0]![0];
    expect(dispatcherOptions).toMatchObject({
      replyToMessageId: "om_quote_reply",
      rootId: "om_original_msg",
    });
    expect(
      vi.mocked(botRuntime.channel.session.recordInboundSession).mock.calls.at(-1)?.[0]
        .updateLastRoute,
    ).toMatchObject({
      to: "chat:oc-group",
      threadId: "om_quote_reply",
    });
  });

  it("uses explicit synthetic typing targets without changing reply routing", async () => {
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

    expectDispatcher({
      replyToMessageId: "om_reply_anchor",
      typingTargetMessageId: "om_reacted_message",
      chatId: "p2p:ou_sender_1",
      sendTarget: "user:ou_sender_1",
    });
  });

  it.each([
    ["omt_dm_thread", "om_dm_root", false, true],
    [undefined, "om_dm_unthreaded_child", true, false],
  ] as const)(
    "routes P2P replies with thread_id=%s",
    async (threadId, replyToMessageId, skipReplyToInMessages, threaded) => {
      const text = "hello inside a DM reply";
      const runtime = await receive({
        messageId: threadId ? "om_dm_child" : "om_dm_unthreaded_child",
        senderOpenId: "ou-dm-sender",
        chatId: threadId ? "oc-dm-threaded" : "oc-dm-unthreaded",
        text,
        message: {
          root_id: "om_dm_root",
          create_time: "1700000000000",
          ...(threadId ? { thread_id: threadId } : {}),
        },
      });

      expectDispatcher({
        replyToMessageId,
        skipReplyToInMessages,
        replyInThread: threaded,
        threadReply: threaded,
        rootId: "om_dm_root",
      });
      expect(inboundContext().BodyForAgent).toContain(text);
      expect(JSON.stringify(vi.mocked(runtime.log).mock.calls)).not.toContain(text);
      expect(inboundContext().Timestamp).toBe(1700000000000);
      expect(formatEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ timestamp: 1700000000000 }),
      );
    },
  );

  it.each([
    ["existing", undefined, undefined],
    ["sender", "root starter", "assistant reply\n\nfollow-up question"],
    ["allowlist", "assistant reply", "assistant reply\n\nallowed follow-up"],
  ] as const)(
    "bootstraps topic history using %s session policy",
    async (mode, starter, history) => {
      const allowlist = mode === "allowlist";
      if (mode === "existing") {
        readSessionUpdatedAt.mockReturnValue(1710000000000);
      } else {
        getMessage.mockResolvedValue({
          messageId: "om_topic_root",
          chatId: "oc-group",
          contentType: "text",
          threadId: "omt_topic_1",
          content: allowlist ? "blocked root starter" : "root starter",
          ...(allowlist ? { senderId: "ou-blocked", senderType: "user" } : {}),
        });
        listThreadMessages.mockResolvedValue(
          allowlist
            ? [
                historyMessage("ou-blocked", "blocked follow-up"),
                historyMessage("app_1", "assistant reply", 1, "app"),
                historyMessage("ou-allowed", "allowed follow-up", 2),
              ]
            : [
                historyMessage("app_1", "assistant reply", 0, "app"),
                historyMessage("user_topic_1", "follow-up question", 1),
              ],
        );
      }
      await receiveGroup(
        {
          messageId: `om_topic_followup_${mode}`,
          senderOpenId: allowlist ? "ou-allowed" : "ou-topic-user",
          senderUserId: mode === "sender" ? "user_topic_1" : undefined,
          text: "current turn",
          message: { root_id: "om_topic_root", thread_id: allowlist ? "omt_topic_1" : undefined },
        },
        { groupSessionScope: mode === "sender" ? "group_topic_sender" : "group_topic" },
        allowlist
          ? {
              groupPolicy: "open",
              groupSenderAllowFrom: ["ou-allowed"],
              contextVisibility: "allowlist",
            }
          : {},
      );
      if (mode === "existing") {
        expect(getMessage).not.toHaveBeenCalled();
        expect(listThreadMessages).not.toHaveBeenCalled();
      }
      const context = inboundContext();
      expect(context).toMatchObject({
        MessageThreadId: "om_topic_root",
        SupplementalContext: {
          thread: {
            starterBody: starter,
            historyBody: history,
            label: "Feishu thread in oc-group",
          },
        },
      });
    },
  );

  it.each([
    ["image", true, ["img_dedup_payload", "img_dedup_payload"], 1],
    ["audio", false, ["file_audio_first", "file_audio_second", "file_audio_first"], 2],
  ] as const)(
    "dedupes %s messages by ID and media key (concurrent=%s)",
    async (type, concurrent, keys, dispatches) => {
      const messageId = `msg-${type}-dedup`;
      if (type === "audio") {
        saveMessageResource.mockResolvedValue(savedMedia("inbound-voice.ogg", "audio/ogg", 5));
        transcribeAudio.mockResolvedValue("voice transcript");
      }
      const dispatch = (key: string) =>
        receiveMedia(
          messageId,
          type,
          type === "image" ? { image_key: key } : { file_key: key, duration: 1200 },
          { senderOpenId: `ou-${type}-dedup` },
        );
      if (concurrent) {
        await Promise.all(keys.map(dispatch));
      } else {
        for (const key of keys) {
          await dispatch(key);
        }
      }
      expect(dispatchReply).toHaveBeenCalledTimes(dispatches);
      if (!concurrent) {
        const transcribeRequest = transcribeAudio.mock.calls[0]![0];
        expect(transcribeRequest.ctx).toEqual(
          expect.objectContaining({
            media: [{ path: "/tmp/inbound-voice.ogg", contentType: "audio/ogg", kind: "audio" }],
            ChatType: "direct",
          }),
        );
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
        expect(saveMessageResource).toHaveBeenCalledTimes(2);
        expect(saveMessageResource.mock.calls.map(([request]) => request)).toMatchObject([
          { messageId, fileKey: "file_audio_first", type: "file" },
          { messageId, fileKey: "file_audio_second", type: "file" },
        ]);
      }
    },
  );

  it("skips empty-text messages with no media to prevent blank user turns in session (#74634)", async () => {
    await receive(
      {
        messageId: "msg-empty-text-74634",
        senderOpenId: "ou-empty-text-sender",
        text: "",
      },
      { dmPolicy: "open", allowFrom: ["*"] },
    );

    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "fetches quoted context only for admitted mention-only replies (mentioned=%s)",
    async (mentioned) => {
      if (mentioned) {
        getMessage.mockResolvedValueOnce({
          messageId: "om_group_quoted_001",
          chatId: "oc-group-90177",
          content: "parent message with context",
          contentType: "text",
        });
      }
      const runtime = await receiveGroup(
        {
          messageId: `msg-group-empty-with-quote-${mentioned}`,
          senderOpenId: "ou-group-sender",
          chatId: "oc-group-90177",
          text: "",
          message: {
            parent_id: "om_group_quoted_001",
            mentions: mentioned
              ? [{ key: "@_bot_1", id: { open_id: "ou-bot-90177" }, name: "Bot", tenant_key: "" }]
              : undefined,
          },
        },
        { requireMention: true },
        { groupPolicy: "open" },
        undefined,
        { botOpenId: "ou-bot-90177" },
      );
      if (mentioned) {
        expect(dispatchReply).toHaveBeenCalledTimes(1);
        expect(inboundContext().Body).toContain("[Replying to:");
        expect(inboundContext().Body).toContain("parent message with context");
        expect(JSON.stringify(vi.mocked(runtime.log).mock.calls)).not.toContain(
          "parent message with context",
        );
      } else {
        expect(getMessage).not.toHaveBeenCalled();
        expect(dispatchReply).not.toHaveBeenCalled();
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
    expect(handleMessage.mock.calls.map(([call]) => call.event)).toEqual([firstEvent, secondEvent]);
    expect(handleMessage.mock.calls.map(([call]) => typeof call.processingClaim?.commit)).toEqual([
      "function",
      "function",
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
