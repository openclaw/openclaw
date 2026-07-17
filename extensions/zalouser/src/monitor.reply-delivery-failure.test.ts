// Zalouser tests cover monitor reply delivery failure propagation.
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send.test-mocks.js";
import "./zalo-js.test-mocks.js";
import { monitorZalouserProvider } from "./monitor.js";
import { sendMessageZalouserMock } from "./monitor.send.test-mocks.js";
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
      },
    },
  };
}

function createDmMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "u-1",
    isGroup: false,
    senderId: "123",
    senderName: "Alice",
    content: "hello",
    timestampMs: Date.now(),
    msgId: "m-1",
    raw: { source: "test" },
    ...overrides,
  };
}

function installRuntime(params: { replyPayload: { text?: string } }) {
  const deliveryFailure: { error?: unknown } = {};
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions, ctx }) => {
    try {
      await dispatcherOptions.deliver(params.replyPayload);
    } catch (err) {
      // Mirror the core dispatcher contract: a throwing deliver marks the reply
      // failed and routes the error to the plugin's onError handler.
      deliveryFailure.error = err;
      dispatcherOptions.onError?.(err, { kind: "final" });
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, ctx };
  });
  const recordInboundSession = vi.fn(async (_params: unknown) => {});
  type TurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
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
        RawBody: paramsLocal.message.rawBody,
        CommandBody: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        BodyForCommands: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        From: paramsLocal.from,
        To: paramsLocal.reply.to,
        SessionKey: paramsLocal.route.dispatchSessionKey ?? paramsLocal.route.routeSessionKey,
        AccountId: paramsLocal.route.accountId ?? paramsLocal.accountId,
        ChatType: paramsLocal.conversation.kind,
        SenderName: paramsLocal.sender.name,
        SenderId: paramsLocal.sender.id,
        Provider: paramsLocal.provider ?? paramsLocal.channel,
        Surface: paramsLocal.surface ?? paramsLocal.provider ?? paramsLocal.channel,
        MessageSid: paramsLocal.messageId,
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
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
        buildPairingReply: vi.fn(() => "pair"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn((body: string) => body.trim().startsWith("/")),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
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
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: "agent:main:zalouser:direct:123",
          accountId: "default",
          mainSessionKey: "agent:main:main",
        })),
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
  return { deliveryFailure };
}

describe("zalouser monitor reply delivery failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates send failures from deliver instead of reporting the reply as delivered", async () => {
    const { deliveryFailure } = installRuntime({
      replyPayload: { text: "zalouser delivery failure probe" },
    });
    sendMessageZalouserMock.mockRejectedValueOnce(new Error("zalouser send boom"));

    const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
    const abortController = new AbortController();
    let resolveProcessed: (() => void) | undefined;
    const processed = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      const resultIndex = enqueueSpy.mock.results.length;
      listenerParams.onMessage(createDmMessage());
      const queued = enqueueSpy.mock.results[resultIndex]?.value;
      if (!(queued instanceof Promise)) {
        throw new Error("Zalouser monitor did not enqueue the inbound message");
      }
      await queued;
      resolveProcessed?.();
      return { stop: vi.fn() };
    });
    try {
      const run = monitorZalouserProvider({
        account: createAccount(),
        config: createConfig(),
        runtime: createZalouserRuntimeEnv(),
        abortSignal: abortController.signal,
      });
      await processed;
      abortController.abort();
      await run;
    } finally {
      enqueueSpy.mockRestore();
    }

    expect(sendMessageZalouserMock).toHaveBeenCalledOnce();
    expect(deliveryFailure.error).toBeInstanceOf(Error);
    expect((deliveryFailure.error as Error).message).toContain("zalouser send boom");
  });
});
