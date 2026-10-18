import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { sendMessageZalouserMock } from "./monitor.send.test-mocks.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  listZaloFriendsMock,
  listZaloGroupsMock,
  startZaloListenerMock,
  sendZaloDeliveredEventMock as sendDeliveredZalouserMock,
  sendZaloSeenEventMock as sendSeenZalouserMock,
  sendZaloTypingEventMock as sendTypingZalouserMock,
} from "./zalo-js.test-mocks.js";
import { resolveZalouserAccountSync } from "./accounts.js";
import {
  createRawZalouserMessageFromNormalized,
  observeZalouserIngressVerdict,
  useZalouserMonitorTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendMessageZalouser } from "./send.js";
import {
  createZalouserDmMessage as createDmMessage,
  createZalouserGroupMessage as createGroupMessage,
  createZalouserRuntimeEnv,
} from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

const withMonitorIngressQueue = useZalouserMonitorTestQueue();

function createAccount(
  config: Partial<ResolvedZalouserAccount["config"]> = {},
): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
      ...config,
    },
  };
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      zalouser: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: {
          "*": { requireMention: true },
        },
      },
    },
  };
}

const createRuntimeEnv = createZalouserRuntimeEnv;

type DispatchReplyCallArg = {
  ctx?: {
    Body?: string;
    BodyForCommands?: string;
    CommandAuthorized?: boolean;
    CommandBody?: string;
    InboundHistory?: unknown;
    OriginatingTo?: string;
    ReplyToBody?: string;
    ReplyToId?: string;
    ReplyToIsQuote?: boolean;
    SessionKey?: string;
    To?: string;
    WasMentioned?: boolean;
  };
};

function mockCallArg(mock: unknown, label: string, index = 0) {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call[0];
}

function dispatchReplyCall(mock: unknown, index = 0): DispatchReplyCallArg {
  return mockCallArg(mock, "dispatch reply", index) as DispatchReplyCallArg;
}

function installRuntime(
  params: {
    commandAuthorized?: boolean;
    replyPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
    replyKind?: "block" | "tool";
    resolveCommandAuthorizedFromAuthorizers?: (params: {
      useAccessGroups: boolean;
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
    }) => boolean;
  } = {},
) {
  const deliveryErrors: unknown[] = [];
  const dispatchReply = vi.fn(async ({ dispatcherOptions, ctx }) => {
    await dispatcherOptions.typingCallbacks?.onReplyStart?.();
    if (params.replyPayload) {
      const info = { kind: params.replyKind ?? "block" };
      try {
        await dispatcherOptions.deliver(params.replyPayload, info);
      } catch (error) {
        deliveryErrors.push(error);
        dispatcherOptions.onError(error, info);
      }
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, ctx };
  });
  const resolveCommandAuthorizedFromAuthorizers = vi.fn(
    (input: {
      useAccessGroups: boolean;
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
    }) => {
      if (params.resolveCommandAuthorizedFromAuthorizers) {
        return params.resolveCommandAuthorizedFromAuthorizers(input);
      }
      return params.commandAuthorized ?? false;
    },
  );
  const resolveAgentRoute = vi.fn(
    (input: { dmScope?: string; peer?: { kind?: string; id?: string } }) => {
      const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
      const peerId = input.peer?.id ?? "1";
      return {
        agentId: "main",
        sessionKey:
          peerKind === "direct" && input.dmScope === "main"
            ? "agent:main:main"
            : `agent:main:zalouser:${peerKind}:${peerId}`,
        accountId: "default",
        mainSessionKey: "agent:main:main",
      };
    },
  );
  const readAllowFromStore = vi.fn(async () => []);
  type TurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
  const dispatch = vi.fn(async (plan: TurnPlan) => {
    const turn = {
      ...plan,
      agentId: plan.route.agentId,
      routeSessionKey: plan.route.sessionKey,
      dispatchReply,
    };
    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg: turn.cfg,
      agentId: turn.agentId,
      channel: "zalouser",
      accountId: turn.accountId,
      ...turn.replyPipeline,
    });
    const dispatchResult = await turn.dispatchReply({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...replyPipeline,
        ...turn.dispatcherOptions,
        deliver: async (...args: Parameters<typeof turn.delivery.deliver>) => {
          const result = await turn.delivery.deliver(...args);
          await turn.delivery.onDelivered?.(args[0], args[1], result);
          return result;
        },
        onError: turn.delivery.onError,
      },
      replyOptions: {
        onModelSelected,
        ...turn.replyOptions,
      },
      replyResolver: turn.replyResolver,
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });
  const buildContext = vi.fn(
    (paramsLocal: Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0]) =>
      ({
        Body: paramsLocal.message.body ?? paramsLocal.message.rawBody,
        BodyForAgent: paramsLocal.message.bodyForAgent ?? paramsLocal.message.rawBody,
        InboundHistory: paramsLocal.message.inboundHistory,
        RawBody: paramsLocal.message.rawBody,
        CommandBody: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        BodyForCommands: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        From: paramsLocal.from,
        To: paramsLocal.reply.to,
        SessionKey: paramsLocal.route.dispatchSessionKey ?? paramsLocal.route.routeSessionKey,
        AccountId: paramsLocal.route.accountId ?? paramsLocal.accountId,
        ChatType: paramsLocal.conversation.kind,
        ConversationLabel: paramsLocal.conversation.label,
        SenderName: paramsLocal.sender.name,
        SenderId: paramsLocal.sender.id,
        Provider: paramsLocal.provider ?? paramsLocal.channel,
        Surface: paramsLocal.surface ?? paramsLocal.provider ?? paramsLocal.channel,
        MessageSid: paramsLocal.messageId,
        MessageSidFull: paramsLocal.messageIdFull,
        OriginatingChannel: paramsLocal.channel,
        OriginatingTo: paramsLocal.reply.originatingTo,
        ...paramsLocal.extra,
      }) as Awaited<ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>>,
  );
  setZalouserRuntime({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
        buildPairingReply: vi.fn(() => "pair"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn((body: string) => body.trim().startsWith("/")),
        resolveCommandAuthorizedFromAuthorizers,
        isControlCommandMessage: vi.fn((body: string) => body.trim().startsWith("/")),
        shouldHandleTextCommands: vi.fn(() => true),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionWithExplicit: vi.fn(
          (input) => input.explicit?.isExplicitlyMentioned === true,
        ),
      },
      routing: {
        resolveAgentRoute,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatchReply,
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        dispatch,
        buildContext:
          buildContext as unknown as PluginRuntime["channel"]["inbound"]["buildContext"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 1200),
      },
    },
  } as unknown as PluginRuntime);

  return {
    deliveryErrors,
    dispatchReply,
    resolveAgentRoute,
    resolveCommandAuthorizedFromAuthorizers,
    readAllowFromStore,
  };
}

function installGroupCommandAuthRuntime() {
  return installRuntime({
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}

async function processMessageThroughMonitor(params: {
  message?: ZaloInboundMessage;
  messages?: ZaloInboundMessage[];
  account?: ResolvedZalouserAccount;
  config?: OpenClawConfig;
  runtime?: ReturnType<typeof createZalouserRuntimeEnv>;
  historyState?: { historyLimit?: number };
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}): Promise<void> {
  const messages = params.messages ?? (params.message ? [params.message] : []);
  const baseAccount = params.account ?? createAccount();
  const account = params.historyState?.historyLimit
    ? {
        ...baseAccount,
        config: { ...baseAccount.config, historyLimit: params.historyState.historyLimit },
      }
    : baseAccount;
  await withMonitorIngressQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    const { promise: processed, resolve: resolveProcessed } = Promise.withResolvers<void>();
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      for (const message of messages) {
        if (!message.msgId) {
          throw new Error("Zalouser monitor test message requires msgId");
        }
        const terminal = observeZalouserIngressVerdict(ingressQueue, message.msgId, "completed");
        await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
        await terminal;
      }
      resolveProcessed();
      return { stop: vi.fn() };
    });
    const run = monitorZalouserProvider({
      account,
      config: params.config ?? createConfig(),
      runtime: params.runtime ?? createRuntimeEnv(),
      abortSignal: abortController.signal,
      statusSink: params.statusSink,
      ingressQueue,
    });
    try {
      await Promise.race([
        processed,
        run.then(() => {
          throw new Error("Zalouser monitor exited before fixture messages were processed");
        }),
      ]);
    } finally {
      abortController.abort();
      await run;
    }
  });
}

function mentionedGroup(overrides: Partial<ZaloInboundMessage> = {}) {
  return createGroupMessage({
    content: "ping @bot",
    hasAnyMention: true,
    wasExplicitlyMentioned: true,
    ...overrides,
  });
}

describe("zalouser monitor group mention gating", () => {
  beforeEach(() => {
    sendMessageZalouserMock.mockClear();
    sendTypingZalouserMock.mockClear();
    sendDeliveredZalouserMock.mockClear();
    sendSeenZalouserMock.mockClear();
    listZaloFriendsMock.mockReset();
    listZaloFriendsMock.mockResolvedValue([]);
    listZaloGroupsMock.mockReset();
    listZaloGroupsMock.mockResolvedValue([]);
    startZaloListenerMock.mockReset();
    startZaloListenerMock.mockResolvedValue({ stop: vi.fn() });
  });

  async function expectSkippedGroupMessage(message?: Partial<ZaloInboundMessage>) {
    const { dispatchReply } = installRuntime();
    await processMessageThroughMonitor({
      message: createGroupMessage(message),
    });
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(sendTypingZalouserMock).not.toHaveBeenCalled();
  }

  async function startMonitorForStartupResolution(
    accountConfig: ResolvedZalouserAccount["config"],
  ) {
    installRuntime();
    const abortController = new AbortController();
    abortController.abort();
    await withMonitorIngressQueue(async (ingressQueue) => {
      await monitorZalouserProvider({
        account: createAccount(accountConfig),
        config: createConfig(),
        runtime: createRuntimeEnv(),
        abortSignal: abortController.signal,
        ingressQueue,
      });
    });
  }

  it("logs missing mentions once with the authored scope after group-name resolution", async () => {
    const { dispatchReply } = installRuntime();
    const runtime = { ...createRuntimeEnv(), log: vi.fn() };
    const account = createAccount({
      dangerouslyAllowNameMatching: true,
      groups: { "g-diagnostic": { requireMention: true } },
    });
    const config = { channels: { zalouser: { accounts: { default: account.config } } } };
    await processMessageThroughMonitor({
      messages: ["mention-drop-1", "mention-drop-2"].map((msgId) =>
        createGroupMessage({ threadId: "g-diagnostic", msgId }),
      ),
      account,
      config,
      runtime,
    });
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(sendTypingZalouserMock).not.toHaveBeenCalled();
    const diagnostics = runtime.log.mock.calls.filter(([line]) => line.includes("drop no mention"));
    expect(diagnostics).toEqual([
      [expect.stringContaining('accounts["default"].groups["g-diagnostic"].requireMention=false')],
    ]);
    expect(diagnostics[0]?.[0]).not.toContain("Alice");
  });

  it("blocks mentioned group messages by default when groupPolicy is omitted", async () => {
    const { dispatchReply } = installRuntime();
    const cfg: OpenClawConfig = { channels: { zalouser: { enabled: true } } };
    const account = resolveZalouserAccountSync({ cfg, accountId: "default" });

    await processMessageThroughMonitor({
      message: mentionedGroup(),
      account,
      config: cfg,
    });

    expect(account.config.groupPolicy).toBe("allowlist");
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("fails closed when requireMention=true but mention detection is unavailable", async () => {
    await expectSkippedGroupMessage({
      canResolveExplicitMention: false,
      hasAnyMention: false,
      wasExplicitlyMentioned: false,
    });
  });

  it.each([
    { content: "/status", expected: { WasMentioned: true } },
    {
      content: "@Bot /new",
      commandContent: "/new",
      hasAnyMention: true,
      wasExplicitlyMentioned: true,
      expected: { CommandBody: "/new", BodyForCommands: "/new" },
    },
  ])("dispatches authorized control command $content", async ({ expected, ...message }) => {
    const { dispatchReply } = installRuntime({ commandAuthorized: true });
    await processMessageThroughMonitor({ message: createGroupMessage(message) });
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReplyCall(dispatchReply).ctx).toMatchObject(expected);
  });

  it("passes long markdown replies through once so formatting happens before chunking", async () => {
    const replyText = `**${"a".repeat(2501)}**`;
    const statusSink = vi.fn();
    installRuntime({
      commandAuthorized: false,
      replyPayload: { text: replyText },
    });

    await processMessageThroughMonitor({
      message: createDmMessage(),
      statusSink,
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZalouserMock).toHaveBeenCalledWith("u-1", replyText, {
      isGroup: false,
      profile: "default",
      textMode: "markdown",
      textChunkMode: "length",
      textChunkLimit: 1200,
      onDeliveryResult: expect.any(Function),
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });

  it.each([
    {
      name: "first attachment tool",
      kind: "tool" as const,
      payload: { text: "caption", mediaUrls: ["https://a/1"] },
    },
    {
      name: "later attachment block",
      kind: "block" as const,
      payload: {
        text: "caption",
        mediaUrls: ["https://a/1", "https://a/2", "https://a/3"],
      },
      partial: true,
      successfulSends: 1,
    },
    {
      name: "later text chunk block",
      kind: "block" as const,
      payload: { text: "reply" },
      partial: true,
    },
  ])("reports $name delivery failures through the canonical dispatcher", async (testCase) => {
    const failure = new Error(`${testCase.name} unavailable`);
    if (testCase.partial) {
      vi.mocked(sendMessageZalouser).mockImplementationOnce(async (_threadId, _text, options) => {
        const result = {
          messageId: "accepted-1",
          receipt: createZalouserSendReceipt({ messageId: "accepted-1", threadId: "u-1" }),
        };
        await options?.onDeliveryResult?.(result);
        if (!testCase.successfulSends) {
          throw failure;
        }
        return result;
      });
    }
    if (!testCase.partial || testCase.successfulSends) {
      sendMessageZalouserMock.mockRejectedValueOnce(failure);
    }
    const runtime = { ...createRuntimeEnv(), error: vi.fn() };
    const statusSink = vi.fn();
    const { deliveryErrors } = installRuntime({
      replyPayload: testCase.payload,
      replyKind: testCase.kind,
    });

    await processMessageThroughMonitor({
      message: createDmMessage(),
      runtime,
      statusSink,
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes((testCase.successfulSends ?? 0) + 1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      `[default] Zalouser ${testCase.kind} reply failed: Error: ${testCase.name} unavailable`,
    );
    expect(deliveryErrors).toHaveLength(1);
    if (testCase.partial) {
      expect(deliveryErrors[0]).toMatchObject({
        cause: failure,
        sentBeforeError: true,
        deliveryResult: { messageIds: ["accepted-1"], visibleReplySent: true },
      });
      expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
    } else {
      expect(deliveryErrors[0]).toBe(failure);
      expect(statusSink).not.toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
    }
    if (testCase.successfulSends) {
      expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
        1,
        "u-1",
        "caption",
        expect.objectContaining({ mediaUrl: "https://a/1" }),
      );
      expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
        2,
        "u-1",
        "",
        expect.objectContaining({ mediaUrl: "https://a/2" }),
      );
    }
  });

  it.each([false, true])("allows static access-group senders (group=%s)", async (isGroup) => {
    const { dispatchReply } = installRuntime();
    await processMessageThroughMonitor({
      message: isGroup ? mentionedGroup({ senderId: "321" }) : createDmMessage(),
      account: createAccount(
        isGroup
          ? { groupPolicy: "allowlist", groupAllowFrom: ["accessGroup:operators"] }
          : { dmPolicy: "allowlist", allowFrom: ["accessGroup:operators"] },
      ),
      config: {
        ...createConfig(),
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { zalouser: ["321"] },
          },
        },
      },
    });

    expect(dispatchReply).toHaveBeenCalledTimes(1);
  });

  it.each([{ allowFrom: ["123"] }, { allowFrom: ["999"], groupAllowFrom: ["123"] }])(
    "authorizes group control commands with %j",
    async (accountConfig) => {
      const { dispatchReply, resolveCommandAuthorizedFromAuthorizers } =
        installGroupCommandAuthRuntime();
      await processMessageThroughMonitor({
        message: mentionedGroup({ content: "/new", commandContent: "/new" }),
        account: createAccount(accountConfig),
      });
      expect(dispatchReply).toHaveBeenCalledTimes(1);
      expect(resolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
      expect(dispatchReplyCall(dispatchReply).ctx?.CommandAuthorized).toBe(true);
    },
  );

  it.each([
    {
      reason: "routed group lacks explicit sender allowlist",
      senderId: "456",
      config: {
        allowFrom: ["123"],
        groups: { "group:g-1": { enabled: true, requireMention: true } },
      },
    },
    {
      reason: "sender absent from groupAllowFrom",
      senderId: "123",
      config: { allowFrom: ["999"], groupAllowFrom: ["999"] },
    },
  ])("blocks groups when $reason", async ({ senderId, config }) => {
    const { dispatchReply } = installRuntime();
    await processMessageThroughMonitor({
      message: mentionedGroup({ senderId }),
      account: createAccount({ groupPolicy: "allowlist", ...config }),
    });

    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it.each([false, true])("gates mutable group-name matches (opt-in=%s)", async (enabled) => {
    const { dispatchReply } = installRuntime();
    await processMessageThroughMonitor({
      message: mentionedGroup({
        threadId: "g-attacker-001",
        groupName: "Trusted Team",
        senderId: "666",
      }),
      account: createAccount({
        ...(enabled ? { dangerouslyAllowNameMatching: true } : {}),
        groupPolicy: "allowlist",
        groupAllowFrom: ["*"],
        groups: {
          "group:g-trusted-001": { enabled: true },
          "Trusted Team": { enabled: true },
        },
      }),
    });
    expect(dispatchReply).toHaveBeenCalledTimes(Number(enabled));
    if (enabled) {
      expect(dispatchReplyCall(dispatchReply).ctx?.To).toBe("zalouser:group:g-attacker-001");
    }
  });

  it.each([false, true])("gates startup name resolution (opt-in=%s)", async (enabled) => {
    listZaloFriendsMock.mockResolvedValue([{ userId: "123", displayName: "Alice" }]);
    listZaloGroupsMock.mockResolvedValue([{ groupId: "g-trusted", name: "Trusted Team" }]);

    await startMonitorForStartupResolution({
      ...(enabled ? { dangerouslyAllowNameMatching: true } : {}),
      dmPolicy: "allowlist",
      allowFrom: ["Alice"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["Alice"],
      groups: {
        "Trusted Team": { enabled: true },
      },
    });

    for (const lookup of [listZaloFriendsMock, listZaloGroupsMock]) {
      if (enabled) {
        expect(lookup).toHaveBeenCalledWith("default");
      } else {
        expect(lookup).not.toHaveBeenCalled();
      }
    }
  });

  it("surfaces quote metadata in inbound reply context", async () => {
    const { dispatchReply, resolveAgentRoute } = installRuntime();
    await processMessageThroughMonitor({
      message: createDmMessage({
        quotedGlobalMsgId: "987654321234",
        quotedOwnerId: "555444333",
        quotedBody: "Previous bot message content",
      }),
    });

    const callArg = dispatchReplyCall(dispatchReply);
    expect(callArg?.ctx).toMatchObject({
      ReplyToId: "987654321234",
      ReplyToBody: "Previous bot message content",
      ReplyToIsQuote: true,
      SessionKey: "agent:main:zalouser:direct:321",
    });
    const routeInput = mockCallArg(resolveAgentRoute, "resolve agent route") as {
      peer?: unknown;
    };
    expect(routeInput?.peer).toEqual({ kind: "direct", id: "321" });
  });

  it("includes skipped group messages as InboundHistory on the next processed message", async () => {
    const { dispatchReply } = installRuntime();
    await processMessageThroughMonitor({
      messages: [
        createGroupMessage({
          content: "first unmentioned line",
          msgId: "history-1",
          timestampMs: 1700000000000,
        }),
        mentionedGroup({
          content: "second line @bot",
          msgId: "history-2",
        }),
        mentionedGroup({
          content: "third line @bot",
          msgId: "history-3",
        }),
      ],
      historyState: { historyLimit: 5 },
    });
    expect(dispatchReply).toHaveBeenCalledTimes(2);
    const firstDispatch = dispatchReplyCall(dispatchReply);
    expect(firstDispatch?.ctx?.InboundHistory).toEqual([
      {
        sender: "Alice",
        body: "first unmentioned line",
        messageId: "history-1",
        timestamp: 1700000000000,
      },
    ]);
    expect(firstDispatch?.ctx?.Body ?? "").toContain("first unmentioned line");

    const secondDispatch = dispatchReplyCall(dispatchReply, 1);
    expect(secondDispatch?.ctx?.InboundHistory).toStrictEqual([]);
  });
});
