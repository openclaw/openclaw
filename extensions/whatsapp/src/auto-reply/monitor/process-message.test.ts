import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

const {
  resolvePolicyMock,
  buildContextMock,
  isControlCommandMessageMock,
  replyPlanParamsMock,
  runChannelInboundEventParamsMock,
  runMessageReceivedMock,
  shouldComputeCommandAuthorizedMock,
  trackBackgroundTaskMock,
  buildInboundLineMock,
  shouldLogVerboseMock,
  inboundInfoMock,
  inboundDebugMock,
} = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  buildContextMock: vi.fn(),
  isControlCommandMessageMock: vi.fn(() => false),
  replyPlanParamsMock: vi.fn(),
  runChannelInboundEventParamsMock: vi.fn(),
  runMessageReceivedMock: vi.fn(async () => undefined),
  shouldComputeCommandAuthorizedMock: vi.fn(() => false),
  trackBackgroundTaskMock: vi.fn(),
  buildInboundLineMock: vi.fn(() => "hi"),
  shouldLogVerboseMock: vi.fn(() => false),
  inboundInfoMock: vi.fn(),
  inboundDebugMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      runChannelInboundEventParamsMock(params);
      return await actual.runChannelInboundEvent(params);
    },
  };
});

vi.mock("../../inbound-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../inbound-policy.js")>()),
  resolveWhatsAppCommandAuthorized: async () => true,
  resolveWhatsAppInboundPolicy: resolvePolicyMock,
}));

vi.mock("./response-prefix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./response-prefix.js")>()),
  resolveWhatsAppResponsePrefix: () => undefined,
}));

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: async (
      params: Parameters<typeof actual.prepareWhatsAppInboundContext>[0],
    ) => {
      const prepared = await actual.prepareWhatsAppInboundContext(params);
      return {
        ...prepared,
        ctxPayload: buildContextMock(params),
      };
    },
    createWhatsAppReplyPlan: (...args: unknown[]) => {
      const params = args[0] as { replyResolver?: unknown };
      replyPlanParamsMock(params);
      return {
        dispatcherOptions: {},
        delivery: { deliver: async () => {} },
        replyOptions: {},
        replyResolver: params.replyResolver,
        finalize: () => true,
      };
    },
    resolveWhatsAppDmRouteTarget: () => null,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("../../identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../identity.js")>()),
  getPrimaryIdentityId: () => null,
  getSelfIdentity: () => ({ e164: "+15550001111" }),
  getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
}));

vi.mock("../loggers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../loggers.js")>()),
  whatsappInboundLog: { info: inboundInfoMock, debug: inboundDebugMock },
}));

vi.mock("./ack-reaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ack-reaction.js")>()),
  maybeSendAckReaction: async () => {},
}));

vi.mock("./inbound-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-context.js")>()),
  resolveVisibleWhatsAppGroupHistory: (params: { history: unknown[] }) => params.history,
  resolveVisibleWhatsAppReplyContext: () => null,
}));

vi.mock("./last-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./last-route.js")>()),
  trackBackgroundTask: trackBackgroundTaskMock,
}));

vi.mock("./message-line.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./message-line.js")>()),
  buildInboundLine: buildInboundLineMock,
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  buildHistoryContextFromEntries: () => "hi",
  createChannelMessageReplyPipeline: () => ({
    onModelSelected: () => {},
    responsePrefix: undefined,
  }),
  logVerbose: () => {},
  resolveChannelContextVisibilityMode: () => "off",
  resolveInboundSessionEnvelopeContextAsync: async () => ({
    storePath: "/tmp",
    envelopeOptions: {},
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  isControlCommandMessage: isControlCommandMessageMock,
  shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
  shouldLogVerbose: shouldLogVerboseMock,
}));

import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { attachWhatsAppIngressLifecycle } from "../../inbound/ingress-lifecycle.js";
import { blockedAdmission, createMonitorContext } from "./monitor.test-support.js";
import { processMessage } from "./process-message.js";

function makePolicy(groups: Record<string, { systemPrompt?: string }> = {}) {
  return {
    account: { accountId: "default", authDir: "/tmp/wa-test-auth", groups },
    groupPolicy: "allowlist",
    configuredAllowFrom: [],
    groupAllowFrom: [],
    isSelfChat: false,
  };
}

const GROUP_JID = "123@g.us";

function makeBaseMsg(overrides: { body?: string; commandBody?: string } = {}) {
  const body = overrides.body ?? "hi";
  return createTestWebInboundMessage({
    event: { id: "msg1", timestamp: 1710000000 },
    payload: { body, commandBody: overrides.commandBody },
    platform: {
      chatJid: GROUP_JID,
      recipientJid: "+15550001111",
    },
    admission: {
      accountId: "default",
      conversation: { kind: "group", id: GROUP_JID },
      sender: { id: "+15550002222" },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
    group: { subject: "Test Group" },
  });
}

const baseRoute = {
  agentId: "main",
  channel: "whatsapp",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group:123@g.us",
  mainSessionKey: "agent:main:whatsapp:group:123@g.us",
  lastRoutePolicy: "main",
  matchedBy: "default",
} as const;

function callProcessMessage({
  replyLoggerInfo = () => {},
  ...overrides
}: Partial<Parameters<typeof processMessage>[0]> & {
  replyLoggerInfo?: () => void;
} = {}) {
  return processMessage({
    ...createMonitorContext(replyLoggerInfo),
    cfg: {},
    msg: makeBaseMsg(),
    route: baseRoute,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistoryLimit: 20,
    maxMediaBytes: 1024,
    ...overrides,
  });
}

describe("processMessage group system prompt wiring", () => {
  beforeEach(() => {
    buildContextMock.mockReset();
    isControlCommandMessageMock.mockReset().mockReturnValue(false);
    resolvePolicyMock.mockReset().mockReturnValue(makePolicy());
    replyPlanParamsMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();
    runMessageReceivedMock.mockClear();
    shouldComputeCommandAuthorizedMock.mockReset().mockReturnValue(false);
    trackBackgroundTaskMock.mockClear();
    buildInboundLineMock.mockReset().mockReturnValue("hi");
    shouldLogVerboseMock.mockReset().mockReturnValue(false);
    inboundInfoMock.mockClear();
    inboundDebugMock.mockClear();
    clearInternalHooks();
    buildContextMock.mockImplementation(
      (params: { groupSystemPrompt?: string; combinedBody?: string }) => ({
        GroupSystemPrompt: params.groupSystemPrompt,
        Body: params.combinedBody ?? "",
      }),
    );
  });

  afterEach(clearInternalHooks);

  it("resolves group systemPrompt from account config and passes it into buildWhatsAppInboundContext", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy({ [GROUP_JID]: { systemPrompt: "from config" } }));

    await callProcessMessage();

    expect(buildContextMock.mock.calls[0]?.[0].groupSystemPrompt).toBe("from config");
  });

  it("keeps generated media notices out of command input", async () => {
    isControlCommandMessageMock.mockReturnValue(true);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    await callProcessMessage({
      msg: makeBaseMsg({
        body: "/reset\n\n[whatsapp attachment unavailable]",
        commandBody: "/reset",
      }),
    });

    expect(shouldComputeCommandAuthorizedMock).toHaveBeenCalledWith("/reset", {});
    expect(isControlCommandMessageMock).toHaveBeenCalledWith("/reset", {});
    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      bodyForAgent: "/reset\n\n[whatsapp attachment unavailable]",
      command: { kind: "text-slash", authorized: true, body: "/reset" },
      rawBody: "/reset",
    });
  });

  it("keeps inbound message content in agent context, not diagnostics", async () => {
    const body = "private WhatsApp message with a confidential quotation";
    buildInboundLineMock.mockReturnValueOnce(body);
    shouldLogVerboseMock.mockReturnValue(true);
    const info = vi.fn();
    await callProcessMessage({ msg: makeBaseMsg({ body }), replyLoggerInfo: info });

    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      bodyForAgent: body,
      combinedBody: body,
      rawBody: body,
    });
    for (const calls of [
      info.mock.calls,
      inboundInfoMock.mock.calls,
      inboundDebugMock.mock.calls,
    ]) {
      expect(JSON.stringify(calls)).not.toContain(body);
    }
    expect(inboundInfoMock).toHaveBeenCalledWith(expect.stringContaining(`${body.length} chars`));
  });

  it("passes pending history to context and clears it after dispatch", async () => {
    const historyKey = "whatsapp:default:group:123@g.us";
    const entries = [
      {
        sender: "Alice (+15550002222)",
        body: "quiet pending context",
        timestamp: 1710000000,
        id: "quiet-msg-1",
        senderJid: "15550002222@s.whatsapp.net",
      },
    ];
    const groupHistories = new Map([[historyKey, entries]]);

    await callProcessMessage({ groupHistories });

    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      groupHistory: entries,
    });
    expect(groupHistories.get(historyKey)).toEqual([]);
  });

  it.each([true, false])(
    "emits canonical WhatsApp hooks only with explicit opt-in: %s",
    async (enabled) => {
      const internalReceived = vi.fn();
      registerInternalHook("message:received", internalReceived);
      buildContextMock.mockImplementationOnce(() => ({
        Body: "hi",
        BodyForCommands: "hi",
        RawBody: "hi",
        CommandBody: "hi",
        From: GROUP_JID,
        To: "+15550001111",
        SessionKey: baseRoute.sessionKey,
        AccountId: "default",
        MessageSid: "msg1",
        SenderId: "+15550002222",
        SenderName: "Alice",
        SenderE164: "+15550002222",
        Timestamp: 1710000000,
        Provider: "whatsapp",
        Surface: "whatsapp",
        SuppressMessageReceivedHooks: true,
        OriginatingChannel: "whatsapp",
        OriginatingTo: GROUP_JID,
        GroupSubject: "Test Group",
      }));

      await callProcessMessage({
        cfg: enabled ? { channels: { whatsapp: { pluginHooks: { messageReceived: true } } } } : {},
      });
      await Promise.resolve();
      await Promise.resolve();
      if (!enabled) {
        expect(runMessageReceivedMock).not.toHaveBeenCalled();
        expect(internalReceived).not.toHaveBeenCalled();
        return;
      }
      const metadata = {
        to: "+15550001111",
        provider: "whatsapp",
        surface: "whatsapp",
        threadId: undefined,
        senderId: "+15550002222",
        senderName: "Alice",
        senderUsername: undefined,
        senderE164: "+15550002222",
        guildId: undefined,
        channelName: undefined,
        topicName: undefined,
      };
      expect(runMessageReceivedMock).toHaveBeenCalledTimes(1);
      expect(runMessageReceivedMock).toHaveBeenCalledWith(
        {
          from: GROUP_JID,
          content: "hi",
          timestamp: 1710000000,
          threadId: undefined,
          messageId: "msg1",
          senderId: "+15550002222",
          sessionKey: baseRoute.sessionKey,
          runId: undefined,
          metadata: {
            ...metadata,
            originatingChannel: "whatsapp",
            originatingTo: GROUP_JID,
            messageId: "msg1",
          },
        },
        {
          channelId: "whatsapp",
          accountId: "default",
          conversationId: GROUP_JID,
          sessionKey: baseRoute.sessionKey,
          messageId: "msg1",
          senderId: "+15550002222",
        },
      );
      expect(internalReceived).toHaveBeenCalledTimes(1);
      const internalEvent = internalReceived.mock.calls[0]![0];
      expect(internalEvent.timestamp).toBeInstanceOf(Date);
      expect({ ...internalEvent, timestamp: undefined }).toEqual({
        type: "message",
        action: "received",
        sessionKey: baseRoute.sessionKey,
        context: {
          from: GROUP_JID,
          content: "hi",
          timestamp: 1710000000,
          channelId: "whatsapp",
          accountId: "default",
          conversationId: GROUP_JID,
          messageId: "msg1",
          metadata,
        },
        timestamp: undefined,
        messages: [],
      });
    },
  );

  it("passes one lifecycle and owning dispatcher through the portable turn boundary", async () => {
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => undefined),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => undefined),
    };
    const dispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }));
    const msg = attachWhatsAppIngressLifecycle(makeBaseMsg(), lifecycle as never);

    await callProcessMessage({ msg, dispatchReplyFromConfig });

    const runParams = runChannelInboundEventParamsMock.mock.calls[0]![0];
    const replyPlanParams = replyPlanParamsMock.mock.calls[0]![0];
    expect(runParams.turnAdoptionLifecycle).toBe(replyPlanParams.turnAdoptionLifecycle);
    expect(dispatchReplyFromConfig).toHaveBeenCalledOnce();
    expect(trackBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(trackBackgroundTaskMock.mock.calls[0]?.[0]).toBeInstanceOf(Set);
    expect(trackBackgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise);
    expect(runParams.raw).not.toHaveProperty("platform");
    expect(runParams.raw).not.toHaveProperty("admission");
  });

  it("drops blocked admission before session record and reply dispatch", async () => {
    const result = await callProcessMessage({
      msg: createTestWebInboundMessage({
        admission: blockedAdmission(),
      }),
    });

    expect(result).toBe(false);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(trackBackgroundTaskMock).not.toHaveBeenCalled();
    expect(replyPlanParamsMock).not.toHaveBeenCalled();
    expect(runMessageReceivedMock).not.toHaveBeenCalled();
  });
});
