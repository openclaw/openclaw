// Zalouser tests: inbound account messagePrefix on agent body (DM path).
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send.test-mocks.js";
import "./zalo-js.test-mocks.js";
import {
  createRawZalouserMessageFromNormalized,
  waitForZalouserIngressVerdict,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import { startZaloListenerMock } from "./zalo-js.test-mocks.js";

function createAccount(): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
      },
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

const createRuntimeEnv = () => createZalouserRuntimeEnv();

type DispatchReplyCallArg = {
  ctx?: {
    Body?: string;
    BodyForAgent?: string;
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

function installRuntime(params: {
  commandAuthorized?: boolean;
  replyPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions, ctx }) => {
    await dispatcherOptions.typingCallbacks?.onReplyStart?.();
    if (params.replyPayload) {
      await dispatcherOptions.deliver(params.replyPayload);
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
  const recordInboundSession = vi.fn(async (_params: unknown) => {});
  const dispatch = vi.fn(async (plan: TurnPlan) => {
    const turn = {
      ...plan,
      agentId: plan.route.agentId,
      routeSessionKey: plan.route.sessionKey,
      storePath: "/tmp",
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
    };
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg: turn.cfg,
      agentId: turn.agentId,
      channel: "zalouser",
      accountId: turn.accountId,
      ...turn.replyPipeline,
    });
    const dispatchResult = await turn.dispatchReplyWithBufferedBlockDispatcher({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...replyPipeline,
        ...turn.dispatcherOptions,
        deliver: async (...args: Parameters<typeof turn.delivery.deliver>) => {
          await turn.delivery.deliver(...args);
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
      groups: {
        resolveRequireMention: vi.fn((input) => {
          const cfg = input.cfg as OpenClawConfig;
          const groupCfg = cfg.channels?.zalouser?.groups ?? {};
          const typedGroupCfg = groupCfg as Record<string, { requireMention?: boolean }>;
          const groupEntry = input.groupId ? typedGroupCfg[input.groupId] : undefined;
          const defaultEntry = typedGroupCfg["*"];
          if (typeof groupEntry?.requireMention === "boolean") {
            return groupEntry.requireMention;
          }
          if (typeof defaultEntry?.requireMention === "boolean") {
            return defaultEntry.requireMention;
          }
          return true;
        }),
      },
      routing: {
        resolveAgentRoute,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp"),
        recordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }) => body),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      inbound: {
        dispatch,
        buildContext:
          buildContext as unknown as PluginRuntime["channel"]["inbound"]["buildContext"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 1200),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime);

  return {
    dispatchReplyWithBufferedBlockDispatcher,
    resolveAgentRoute,
    resolveCommandAuthorizedFromAuthorizers,
    readAllowFromStore,
  };
}

async function processMessageThroughMonitor(params: {
  message?: ZaloInboundMessage;
  messages?: ZaloInboundMessage[];
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: ReturnType<typeof createZalouserRuntimeEnv>;
  historyState?: { historyLimit?: number };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const messages = params.messages ?? (params.message ? [params.message] : []);
  const account = params.historyState?.historyLimit
    ? {
        ...params.account,
        config: { ...params.account.config, historyLimit: params.historyState.historyLimit },
      }
    : params.account;
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    let resolveProcessed: (() => void) | undefined;
    const processed = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      for (const message of messages) {
        await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
        if (!message.msgId) {
          throw new Error("Zalouser monitor test message requires msgId");
        }
        await waitForZalouserIngressVerdict(ingressQueue, message.msgId, "completed");
      }
      resolveProcessed?.();
      return { stop: vi.fn() };
    });
    const run = monitorZalouserProvider({
      account,
      config: params.config,
      runtime: params.runtime,
      abortSignal: abortController.signal,
      statusSink: params.statusSink,
      ingressQueue,
    });
    await processed;
    abortController.abort();
    await run;
  });
}

function createDmMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "u-1",
    isGroup: false,
    senderId: "321",
    senderName: "Bob",
    groupName: undefined,
    content: "hello",
    timestampMs: Date.now(),
    msgId: "dm-1",
    raw: { source: "test" },
    ...overrides,
  };
}

describe("zalouser monitor messagePrefix", () => {
  it("prefixes agent body with account messagePrefix on DM ingress", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createDmMessage({ content: "hello", msgId: "dm-prefix-1" }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          messagePrefix: "[acct]",
          dmPolicy: "open",
        },
      },
      config: {
        ...createConfig(),
        messages: { responsePrefix: "[global]" },
      },
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const call = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    // Production monitor sets bodyForAgent to prefix + raw body.
    expect(call?.ctx?.BodyForAgent).toBe("[acct] hello");
    expect(call?.ctx?.Body ?? "").toContain("[acct] hello");
  });

  it("honors explicit empty account messagePrefix without inventing a prefix", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createDmMessage({ content: "hello", msgId: "dm-prefix-empty" }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          messagePrefix: "",
          // Outbound-only; must not appear on inbound BodyForAgent.
          responsePrefix: "[outbound]",
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const call = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(call?.ctx?.BodyForAgent).toBe("hello");
    expect(call?.ctx?.BodyForAgent).not.toContain("[outbound]");
  });
});
