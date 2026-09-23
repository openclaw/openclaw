import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
// Whatsapp tests cover process message plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchReplyFromConfigForTest,
  installWebAutoReplyUnitTestHooks,
} from "../../auto-reply.test-harness.js";
import { attachWhatsAppIngressLifecycle } from "../../inbound/ingress-lifecycle.js";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { processMessage } from "./process-message.js";

const {
  buildContextMock,
  replyPlanParamsMock,
  runChannelInboundEventParamsMock,
  runMessageReceivedMock,
  trackBackgroundTaskMock,
} = vi.hoisted(() => ({
  buildContextMock: vi.fn(),
  replyPlanParamsMock: vi.fn(),
  runChannelInboundEventParamsMock: vi.fn(),
  runMessageReceivedMock: vi.fn(async () => undefined),
  trackBackgroundTaskMock: vi.fn(),
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

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: async (
      params: Parameters<typeof actual.prepareWhatsAppInboundContext>[0],
    ) => {
      buildContextMock(params);
      return await actual.prepareWhatsAppInboundContext(params);
    },
    createWhatsAppReplyPlan: (params: Parameters<typeof actual.createWhatsAppReplyPlan>[0]) => {
      replyPlanParamsMock(params);
      return actual.createWhatsAppReplyPlan(params);
    },
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return {
    ...actual,
    trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
      trackBackgroundTaskMock(tasks, task);
      return actual.trackBackgroundTask(tasks, task);
    },
  };
});

const GROUP_JID = "123@g.us";

function makeBaseMsg(overrides: { body?: string; commandBody?: string } = {}) {
  const body = overrides.body ?? "hi";
  return createTestWebInboundMessage({
    event: {
      id: "msg1",
      timestamp: 1710000000,
    },
    payload: {
      body,
      commandBody: overrides.commandBody,
    },
    platform: {
      chatJid: GROUP_JID,
      recipientJid: "+15550001111",
      senderJid: "15550002222@s.whatsapp.net",
      senderE164: "+15550002222",
      senderName: "Alice",
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "r1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "m1"),
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "group",
        id: GROUP_JID,
      },
      sender: {
        id: "+15550002222",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    group: {
      subject: "Test Group",
    },
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
};

async function callProcessMessage(
  overrides: {
    cfg?: OpenClawConfig;
    dispatchReplyFromConfig?: Parameters<typeof processMessage>[0]["dispatchReplyFromConfig"];
    groupHistories?: Map<string, unknown[]>;
    msg?: unknown;
  } = {},
) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const cfg: OpenClawConfig = {
    ...overrides.cfg,
    commands: { useAccessGroups: false, ...overrides.cfg?.commands },
    channels: { whatsapp: { allowFrom: ["*"], ...overrides.cfg?.channels?.whatsapp } },
  };
  const result = await processMessage({
    cfg,
    msg: (overrides.msg ?? makeBaseMsg()) as never,
    route: baseRoute as never,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistories: (overrides.groupHistories ?? new Map()) as never,
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    dispatchReplyFromConfig: overrides.dispatchReplyFromConfig ?? dispatchReplyFromConfigForTest,
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks,
  });
  await Promise.all(backgroundTasks);
  return result;
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage group system prompt wiring", () => {
  installWebAutoReplyUnitTestHooks();
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("resolves group systemPrompt from account config and passes it into buildWhatsAppInboundContext", async () => {
    await callProcessMessage({
      cfg: { channels: { whatsapp: { groups: { [GROUP_JID]: { systemPrompt: "from config" } } } } },
    });

    expect(
      (
        mockCallArg(buildContextMock, "buildWhatsAppInboundContext") as {
          groupSystemPrompt?: string;
        }
      ).groupSystemPrompt,
    ).toBe("from config");
    expect(mockCallArg(replyPlanParamsMock, "createWhatsAppReplyPlan")).toMatchObject({
      context: { GroupSystemPrompt: "from config" },
    });
  });

  it.each([
    {
      name: "marks detected WhatsApp slash messages as text command turns",
      message: { body: "/status" },
      expectedContext: {
        command: {
          kind: "text-slash",
          authorization: { kind: "authorized" },
          body: "/status",
        },
        rawBody: "/status",
      },
    },
    {
      name: "keeps generated media notices out of command input",
      message: {
        body: "/reset\n\n[whatsapp attachment unavailable]",
        commandBody: "/reset",
      },
      expectedContext: {
        bodyForAgent: "/reset\n\n[whatsapp attachment unavailable]",
        command: {
          kind: "text-slash",
          authorization: { kind: "authorized" },
          body: "/reset",
        },
        rawBody: "/reset",
      },
    },
    {
      name: "keeps backtick-wrapped paths out of command authorization",
      message: { body: "please inspect `/tmp/foo`" },
      expectedContext: {
        command: {
          kind: "normal",
          authorization: { kind: "not_checked" },
          body: "please inspect `/tmp/foo`",
        },
        rawBody: "please inspect `/tmp/foo`",
      },
    },
  ])("$name", async ({ message, expectedContext }) => {
    await callProcessMessage({ msg: makeBaseMsg(message) });

    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject(
      expectedContext,
    );
    if (message.body === "please inspect `/tmp/foo`") {
      buildContextMock.mockClear();
      await callProcessMessage({ msg: makeBaseMsg({ body: "please inspect /tmp/foo" }) });
      expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject({
        command: {
          kind: "normal",
          authorization: { kind: "authorized" },
          body: "please inspect /tmp/foo",
        },
        rawBody: "please inspect /tmp/foo",
      });
    }
  });

  it("passes pending group history from the history window into inbound context", async () => {
    const groupHistories = new Map<string, unknown[]>([
      [
        "whatsapp:default:group:123@g.us",
        [
          {
            sender: "Alice (+15550002222)",
            body: "quiet pending context",
            timestamp: 1710000000,
            id: "quiet-msg-1",
            senderJid: "15550002222@s.whatsapp.net",
          },
        ],
      ],
    ]);

    await callProcessMessage({ groupHistories });

    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject({
      groupHistory: [
        {
          sender: "Alice (+15550002222)",
          body: "quiet pending context",
          timestamp: 1710000000,
          id: "quiet-msg-1",
          senderJid: "15550002222@s.whatsapp.net",
        },
      ],
    });
  });

  it("fires message_received hooks with canonical WhatsApp correlation fields", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);

    await callProcessMessage({
      cfg: {
        channels: {
          whatsapp: {
            pluginHooks: {
              messageReceived: true,
            },
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

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
          to: "+15550001111",
          provider: "whatsapp",
          surface: "whatsapp",
          threadId: undefined,
          originatingChannel: "whatsapp",
          originatingTo: GROUP_JID,
          messageId: "msg1",
          senderId: "+15550002222",
          senderName: "Alice",
          senderUsername: undefined,
          senderE164: "+15550002222",
          guildId: undefined,
          channelName: undefined,
          topicName: undefined,
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
    const internalEvent = mockCallArg(internalReceived, "internal message received") as Record<
      string,
      unknown
    >;
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
        metadata: {
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
        },
      },
      timestamp: undefined,
      messages: [],
    });
  });

  it("does not fire WhatsApp message_received hooks without explicit opt-in", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);

    await callProcessMessage();

    expect(runMessageReceivedMock).not.toHaveBeenCalled();
    expect(internalReceived).not.toHaveBeenCalled();
  });

  it("tracks session metadata writes as connection background tasks", async () => {
    await callProcessMessage();

    expect(trackBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask")).toBeInstanceOf(Set);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask", 0, 1)).toBeInstanceOf(
      Promise,
    );
  });

  it("passes one lifecycle and owning dispatcher through the portable turn boundary", async () => {
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => undefined),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => undefined),
    };
    const dispatchReplyFromConfig = vi.fn(dispatchReplyFromConfigForTest);
    const msg = attachWhatsAppIngressLifecycle(makeBaseMsg(), lifecycle as never);

    await callProcessMessage({ msg, dispatchReplyFromConfig });

    const runParams = mockCallArg(runChannelInboundEventParamsMock, "runChannelInboundEvent") as {
      raw?: unknown;
      turnAdoptionLifecycle?: unknown;
    };
    const replyPlanParams = mockCallArg(replyPlanParamsMock, "createWhatsAppReplyPlan") as {
      turnAdoptionLifecycle?: unknown;
    };
    expect(runParams.turnAdoptionLifecycle).toBe(replyPlanParams.turnAdoptionLifecycle);
    expect(dispatchReplyFromConfig).toHaveBeenCalledOnce();
    expect(runParams.raw).not.toHaveProperty("platform");
    expect(runParams.raw).not.toHaveProperty("admission");
  });

  it("drops blocked admission before session record and reply dispatch", async () => {
    const result = await callProcessMessage({
      msg: createTestWebInboundMessage({
        admission: {
          ingress: {
            admission: "drop",
            decision: "block",
            reasonCode: "dm_policy_not_allowlisted",
          },
          senderAccess: {
            allowed: false,
            decision: "block",
            reasonCode: "dm_policy_not_allowlisted",
          },
          activationAccess: {
            allowed: false,
            shouldSkip: true,
            reasonCode: "dm_policy_not_allowlisted",
          },
        },
      }),
    });

    expect(result).toBe(false);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(trackBackgroundTaskMock).not.toHaveBeenCalled();
    expect(replyPlanParamsMock).not.toHaveBeenCalled();
    expect(runChannelInboundEventParamsMock).not.toHaveBeenCalled();
    expect(runMessageReceivedMock).not.toHaveBeenCalled();
  });
});
