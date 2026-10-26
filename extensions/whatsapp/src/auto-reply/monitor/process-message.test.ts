import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

const {
  resolvePolicyMock,
  isControlCommandMessageMock,
  replyPlanParamsMock,
  runMessageReceivedMock,
  shouldComputeCommandAuthorizedMock,
  trackBackgroundTaskMock,
  shouldLogVerboseMock,
  inboundInfoMock,
  inboundDebugMock,
  dmRouteTargetMock,
} = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  isControlCommandMessageMock: vi.fn(() => false),
  replyPlanParamsMock: vi.fn(),
  runMessageReceivedMock: vi.fn(async () => undefined),
  shouldComputeCommandAuthorizedMock: vi.fn(() => false),
  trackBackgroundTaskMock: vi.fn(),
  shouldLogVerboseMock: vi.fn(() => false),
  inboundInfoMock: vi.fn(),
  inboundDebugMock: vi.fn(),
  dmRouteTargetMock: vi.fn<() => string | null>(() => null),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: vi.fn(actual.runChannelInboundEvent),
  };
});

vi.mock("../../inbound-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../inbound-policy.js")>()),
  resolveWhatsAppCommandAuthorized: async () => true,
  resolveWhatsAppInboundPolicy: resolvePolicyMock,
}));

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: vi.fn(actual.prepareWhatsAppInboundContext),
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
    resolveWhatsAppDmRouteTarget: dmRouteTargetMock,
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
    envelopeOptions: { includeTimestamp: false },
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  isControlCommandMessage: isControlCommandMessageMock,
  shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
  shouldLogVerbose: shouldLogVerboseMock,
}));

import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { attachWhatsAppIngressLifecycle } from "../../inbound/ingress-lifecycle.js";
import { prepareWhatsAppInboundContext } from "./inbound-dispatch.js";
import { blockedAdmission, createMonitorContext } from "./monitor.test-support.js";
import { processMessage } from "./process-message.js";

const buildContextMock = vi.mocked(prepareWhatsAppInboundContext);
const runChannelInboundEventParamsMock = vi.mocked(runChannelInboundEvent);
function makePolicy() {
  return {
    account: { accountId: "default", authDir: "/tmp/wa-test-auth", groups: {} },
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

describe("processMessage inbound context", () => {
  beforeEach(() => {
    buildContextMock.mockClear();
    isControlCommandMessageMock.mockReset().mockReturnValue(false);
    resolvePolicyMock.mockReset().mockReturnValue(makePolicy());
    replyPlanParamsMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();
    runMessageReceivedMock.mockClear();
    shouldComputeCommandAuthorizedMock.mockReset().mockReturnValue(false);
    trackBackgroundTaskMock.mockClear();
    shouldLogVerboseMock.mockReset().mockReturnValue(false);
    inboundInfoMock.mockClear();
    inboundDebugMock.mockClear();
    dmRouteTargetMock.mockReset().mockReturnValue(null);
    clearInternalHooks();
  });

  afterEach(clearInternalHooks);

  type Prompts = Record<string, { systemPrompt?: string | null }>;
  const prompts = (specific?: string | null): Prompts => ({
    specific: { systemPrompt: specific },
    "*": { systemPrompt: "wildcard" },
  });
  it.each<["group" | "direct", string, Prompts | undefined, string | undefined, string?]>([
    ["group", "", prompts(), undefined],
    ["group", "specific", undefined, undefined],
    ["group", "specific", prompts("  chosen  "), "chosen"],
    ["group", "specific", { "*": { systemPrompt: "wildcard" } }, "wildcard"],
    ["group", "specific", prompts("   "), undefined],
    ["group", "specific", { specific: {} }, undefined],
    ["group", "specific", prompts(null), "wildcard"],
    ["direct", "specific", prompts("  chosen  "), "chosen"],
    ["direct", "conversation", prompts("chosen"), "chosen", "specific"],
  ])("selects %s prompt for %s: %j", async (kind, targetId, entries, expected, routeTarget) => {
    dmRouteTargetMock.mockReturnValue(routeTarget ?? null);
    const otherMap = { "*": { systemPrompt: "wrong conversation kind" } };
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(),
      account: {
        ...makePolicy().account,
        groups: kind === "group" ? entries : otherMap,
        direct: kind === "direct" ? entries : otherMap,
      },
    });
    await callProcessMessage({
      msg: createTestWebInboundMessage({ admission: { conversation: { kind, id: targetId } } }),
    });
    expect(buildContextMock.mock.calls[0]?.[0].groupSystemPrompt).toBe(expected);
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

    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      bodyForAgent: "/reset\n\n[whatsapp attachment unavailable]",
      command: { kind: "text-slash", authorized: true, body: "/reset" },
      rawBody: "/reset",
    });
  });

  it("keeps inbound message content in agent context, not diagnostics", async () => {
    const body = "private WhatsApp message with a confidential quotation";
    const combinedBody = `[WhatsApp 123@g.us] Alice (+15550002222): ${body}`;
    shouldLogVerboseMock.mockReturnValue(true);
    const info = vi.fn();
    await callProcessMessage({ msg: makeBaseMsg({ body }), replyLoggerInfo: info });

    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      bodyForAgent: body,
      combinedBody,
      rawBody: body,
    });
    for (const calls of [
      info.mock.calls,
      inboundInfoMock.mock.calls,
      inboundDebugMock.mock.calls,
    ]) {
      expect(JSON.stringify(calls)).not.toContain(body);
    }
  });

  it("passes pending history to context and clears it after dispatch", async () => {
    const historyKey = "whatsapp:default:group:123@g.us";
    const entries = [{ sender: "Alice (+15550002222)", body: "quiet pending context" }];
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
      const message = {
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        messageId: "msg1",
      };
      expect(runMessageReceivedMock).toHaveBeenCalledTimes(1);
      expect(runMessageReceivedMock).toHaveBeenCalledWith(expect.objectContaining(message), {
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        sessionKey: baseRoute.sessionKey,
        messageId: "msg1",
        senderId: "+15550002222",
      });
      expect(internalReceived).toHaveBeenCalledTimes(1);
      const internalEvent = internalReceived.mock.calls[0]![0];
      expect(internalEvent.timestamp).toBeInstanceOf(Date);
      expect(internalEvent).toMatchObject({
        type: "message",
        action: "received",
        sessionKey: baseRoute.sessionKey,
        context: {
          ...message,
          channelId: "whatsapp",
          accountId: "default",
          conversationId: GROUP_JID,
        },
      });
    },
  );

  it("passes one lifecycle and owning dispatcher through the portable turn boundary", async () => {
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
