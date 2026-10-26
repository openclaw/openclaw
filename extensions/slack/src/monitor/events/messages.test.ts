import type { App } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageHandler } from "../message-handler.js";
import { createInboundSlackTestContext } from "../message-handler/prepare.test-helpers.js";
import { createSlackSystemEventRouteResolver } from "../system-event-session.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const { messageQueueMock, messageAllowMock, inboundInfoSpy, noteConversationMessageMock } =
  vi.hoisted(() => ({
    messageQueueMock: vi.fn(),
    messageAllowMock: vi.fn(),
    inboundInfoSpy: vi.fn(),
    noteConversationMessageMock: vi.fn(),
  }));

vi.mock("../../draft-message-boundaries.js", () => ({
  noteSlackDraftConversationMessage: (...args: unknown[]) => noteConversationMessageMock(...args),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const makeLogger = () => {
    const logger = {
      subsystem: "test",
      isEnabled: () => true,
      trace: () => {},
      debug: () => {},
      info: inboundInfoSpy,
      warn: () => {},
      error: () => {},
      fatal: () => {},
      raw: () => {},
      child: () => logger,
    };
    return logger;
  };
  return { ...actual, createSubsystemLogger: () => makeLogger() };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => messageQueueMock(text, { ...options, sessionKey: route.sessionKey }),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
  };
});
vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  chunkItems: <T>(items: T[]) => [items],
  markdownToIR: (text: string) => text,
  renderMarkdownIRChunksWithinLimit: (text: string) => [text],
  renderMarkdownWithMarkers: (text: string) => text,
  sanitizeAssistantVisibleText: (text: string) => text,
  stripReasoningTagsFromText: (text: string) => text,
}));

let registerSlackMessageEvents: typeof import("./messages.js").registerSlackMessageEvents;

function inboundLogLines(): string[] {
  return inboundInfoSpy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string" && line.startsWith("Inbound "));
}

type MessageHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
  context?: Record<string, unknown>;
  client?: object;
}) => Promise<void>;
type RegisteredEventName = "message" | "app_mention";

function createHandlers(eventName: RegisteredEventName, overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn<SlackMessageHandler>(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    ctx: harness.ctx,
    handler: requireMessageHandler(harness.getHandler(eventName) as MessageHandler | null),
    handleSlackMessage,
  };
}

const enterpriseIdentity = {
  kind: "enterprise",
  apiAppId: "A_TEST",
  enterpriseId: "E_TEST",
} as const;

function createEnterpriseHandlers(eventName: RegisteredEventName) {
  const handlers = createHandlers(eventName);
  handlers.ctx.installationIdentity = enterpriseIdentity;
  return handlers;
}

function requireMessageHandler(handler: MessageHandler | null): MessageHandler {
  if (!handler) {
    throw new Error("expected Slack message event handler");
  }
  return handler;
}

beforeAll(async () => {
  ({ registerSlackMessageEvents } = await import("./messages.js"));
});

beforeEach(() => {
  messageQueueMock.mockClear();
  messageAllowMock.mockReset().mockResolvedValue([]);
  noteConversationMessageMock.mockClear();
  inboundInfoSpy.mockClear();
});

const assistantBlocks = () => [
  {
    type: "data_visualization",
    title: "Latency",
    chart: {
      type: "line",
      series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
      axis_config: { categories: ["Mon"] },
    },
  },
];
const assistantThread = () => ({
  channel_id: "D1",
  thread_ts: "123.000",
  context: { channel_id: "C123", team_id: "T123" },
});

function makeAssistantChangedEvent() {
  return {
    type: "message",
    subtype: "message_changed",
    channel: "D1",
    channel_type: "im",
    user: "U_BOT",
    message: {
      ts: "123.456",
      thread_ts: "123.000",
      user: "U_BOT",
      text: "assistant wrapped user text",
      blocks: assistantBlocks(),
      metadata: { event_payload: { user: "UREAL123" } },
      assistant_thread: assistantThread(),
    },
    previous_message: { ts: "123.456", user: "U_BOT" },
    event_ts: "123.789",
  };
}

function makeAppMentionEvent(channel = "C123") {
  return {
    type: "app_mention",
    channel,
    channel_type: "channel",
    user: "U1",
    text: "<@U_BOT> hello",
    ts: "123.456",
  };
}

async function dispatch(
  eventName: RegisteredEventName,
  event: Record<string, unknown>,
  overrides?: SlackSystemEventTestOverrides,
) {
  const { handler, handleSlackMessage } = createHandlers(eventName, overrides);
  await handler({ event, body: {} });
  return handleSlackMessage;
}

describe("registerSlackMessageEvents", () => {
  it("forwards durable ingress ownership and propagates dispatch failure", async () => {
    const { handler, handleSlackMessage } = createHandlers("message");
    const dispatchError = new Error("transient dispatch failure");
    handleSlackMessage.mockRejectedValue(dispatchError);
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };

    await expect(
      handler({
        event: {
          type: "message",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "hello",
          ts: "123.456",
        },
        body: {},
        context: { openclawIngressLifecycle: turnAdoptionLifecycle },
      }),
    ).rejects.toBe(dispatchError);

    expect(handleSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", ts: "123.456" }),
      expect.objectContaining({
        source: "message",
        awaitDispatch: true,
        turnAdoptionLifecycle,
      }),
    );
  });

  it("accepts two org workspaces and preserves each listener scope", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const clients = [{ id: "one" }, { id: "two" }];
    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "hello",
          ts: `123.${index}`,
        },
        body: { api_app_id: "A_TEST" },
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId },
        client: clients[index],
      });
    }

    expect(handleSlackMessage).toHaveBeenCalledTimes(2);
    const calls = handleSlackMessage.mock.calls as unknown as Array<
      [unknown, { awaitDispatch?: boolean; eventScope?: unknown }]
    >;
    expect(calls[0]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T111", client: clients[0] },
    });
    expect(calls[1]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T222", client: clients[1] },
    });
  });

  it("drops bot-authored enterprise app_mention events in favor of the message event", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("app_mention");
    await handler({
      event: { ...makeAppMentionEvent(), bot_id: "B_OTHER" },
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(inboundLogLines()).toEqual([]);
  });

  it("passes enterprise thread_broadcast through listener-scoped dispatch", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const event = {
      type: "message",
      subtype: "thread_broadcast",
      channel: "C123",
      user: "U123",
      message: { ts: "123.456", user: "U123" },
      event_ts: "123.456",
      bot_id: "B_OTHER",
    };
    const client = {};
    await handler({
      event,
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client,
    });

    expect(handleSlackMessage).toHaveBeenCalledExactlyOnceWith(
      event,
      expect.objectContaining({
        source: "message",
        awaitDispatch: true,
        eventScope: expect.objectContaining({ teamId: "T111", client }),
      }),
    );
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("rehydrates assistant DM message_changed events with a metadata user as inbound messages", async () => {
    const handleSlackMessage = await dispatch("message", makeAssistantChangedEvent());

    expect(handleSlackMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "D1",
        channel_type: "im",
        user: "UREAL123",
        text: "assistant wrapped user text",
        ts: "123.456",
        thread_ts: "123.000",
        assistant_thread: assistantThread(),
        blocks: assistantBlocks(),
      }),
      { source: "message" },
    );
    expect(noteConversationMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "D1",
        threadTs: "123.000",
        messageTs: "123.456",
        userId: "UREAL123",
      }),
    );
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("drops self-authored message_changed events that only include block user IDs", async () => {
    const handleSlackMessage = await dispatch("message", {
      ...makeAssistantChangedEvent(),
      message: {
        ts: "123.456",
        user: "U_BOT",
        text: "preview edit with mention",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "user", user_id: "UREAL123" }],
              },
            ],
          },
        ],
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it.each([
    ["channel", { subtype: "message_deleted" }, true],
    ["im", {}, false],
    ["channel", { root: true }, false],
    ["channel", { previousOnly: true }, true],
    ["channel", { root: true, parentUserId: "U_PARENT" }, true],
    ["mpim", { denied: true }, false],
    ["channel", { enterprise: true }, true],
  ] as const)(
    "routes %s events (%j, thread session: %s)",
    async (channelType, scenario, threadSession) => {
      const subtype = "subtype" in scenario ? scenario.subtype : "message_changed";
      const actualSystemEvents = await vi.importActual<
        typeof import("openclaw/plugin-sdk/system-event-runtime")
      >("openclaw/plugin-sdk/system-event-runtime");
      const { resetSystemEventsForTest } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/test-fixtures")
      >("openclaw/plugin-sdk/test-fixtures");
      resetSystemEventsForTest();
      messageQueueMock.mockImplementation(
        (text: string, { sessionKey, ...options }: { sessionKey: string }) =>
          actualSystemEvents.enqueueRoutedSystemEvent(
            text,
            { agentId: "main", sessionKey },
            options,
          ),
      );

      const senderId = "U123";
      const denied = "denied" in scenario;
      const enterprise = "enterprise" in scenario;
      const harness = createSlackSystemEventTestHarness({
        channelType,
        ...(channelType === "mpim" ? { allowFrom: denied ? ["U_OTHER"] : [senderId] } : {}),
      });
      harness.ctx.cfg = { channels: { slack: { enabled: true } } };
      harness.ctx.channelsConfigKeys = [];
      if (enterprise) {
        harness.ctx.installationIdentity = enterpriseIdentity;
      }
      harness.ctx.resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
        cfg: harness.ctx.cfg,
        accountId: harness.ctx.accountId,
        getTeamId: () => harness.ctx.teamId,
        mainKey: "agent:main:main",
        threadInheritParent: false,
        recallSlackChannelType: () => channelType,
      });
      registerSlackMessageEvents({ ctx: harness.ctx, handleSlackMessage: async () => {} });

      const threadTs = "1712345678.123456";
      const channelId = channelType === "im" ? "D123" : channelType === "mpim" ? "G123" : "C123";
      const nestedMessage = {
        ts: "root" in scenario ? threadTs : "1712345678.654321",
        thread_ts: threadTs,
        user: senderId,
        ...("parentUserId" in scenario ? { parent_user_id: scenario.parentUserId } : {}),
      };
      const event = {
        type: "message",
        subtype,
        channel: channelId,
        channel_type: channelType,
        previous_message: nestedMessage,
        event_ts: "1712345679.000000",
        ...(subtype === "message_changed"
          ? {
              message:
                "previousOnly" in scenario
                  ? { ts: nestedMessage.ts, user: senderId }
                  : nestedMessage,
            }
          : { deleted_ts: nestedMessage.ts }),
      };
      await requireMessageHandler(harness.getHandler("message") as MessageHandler | null)({
        event,
        body: { api_app_id: "A_TEST", event_id: `Ev-${channelType}-${subtype}` },
        ...(enterprise
          ? {
              context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T_GRID" },
              client: {},
            }
          : {}),
      });

      const peer = `${enterprise ? "team:t_grid:channel:" : ""}${channelId.toLowerCase()}`;
      const parentSessionKey =
        channelType === "im"
          ? "agent:main:main"
          : `agent:main:slack:${channelType === "mpim" ? "group" : "channel"}:${peer}`;
      const threadSessionKey = `${parentSessionKey}:thread:${threadTs}`;

      expect(actualSystemEvents.peekSystemEventEntries(parentSessionKey)).toHaveLength(
        denied || threadSession ? 0 : 1,
      );
      expect(actualSystemEvents.peekSystemEventEntries(threadSessionKey)).toHaveLength(
        threadSession ? 1 : 0,
      );
      resetSystemEventsForTest();
    },
  );

  it("keeps bot edit and delete events on a remembered C-prefix mpDM session", async () => {
    const handlers: Record<string, MessageHandler> = {};
    const conversationsInfo = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const app = {
      client: {
        conversations: { info: conversationsInfo },
        users: {
          info: vi.fn().mockResolvedValue({ user: { name: "other-agent" } }),
        },
      },
      event: (name: string, handler: MessageHandler) => {
        handlers[name] = handler;
      },
    } as unknown as App;
    const slack = {
      enabled: true,
      groupPolicy: "open" as const,
      allowFrom: ["*"],
      dm: { groupEnabled: true },
    };
    const ctx = createInboundSlackTestContext({
      app,
      cfg: { channels: { slack } },
      defaultRequireMention: false,
    });
    const handleSlackMessage = vi.fn(async () => {});
    registerSlackMessageEvents({ ctx, handleSlackMessage });
    const handler = requireMessageHandler(handlers.message ?? null);
    const emit = (event: Record<string, unknown>) =>
      handler({
        event: { type: "message", channel: "C0MPDM42", ...event },
        body: {},
      });

    await emit({
      channel_type: "mpim",
      user: "U_HUMAN",
      text: "human seed",
      ts: "1.000",
    });
    await emit({
      subtype: "message_changed",
      message: { ts: "2.000", bot_id: "B_OTHER" },
      previous_message: { ts: "1.000", bot_id: "B_OTHER" },
      event_ts: "2.100",
    });
    await emit({
      subtype: "message_deleted",
      deleted_ts: "2.000",
      previous_message: { ts: "2.000", bot_id: "B_OTHER" },
      event_ts: "3.000",
    });

    const sessionKeys = messageQueueMock.mock.calls.map(
      (call) => (call[1] as { sessionKey?: string }).sessionKey,
    );
    expect(sessionKeys).toEqual([
      "agent:main:slack:group:c0mpdm42",
      "agent:main:slack:group:c0mpdm42",
    ]);
    expect(handleSlackMessage).toHaveBeenCalledOnce();
    expect(conversationsInfo).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["metadata MPIM", "C0MPDM42", "mpim"],
    ["remembered MPIM", "C0MPDM42", "channel"],
    ["group", "G123", "group"],
    ["lookup failure", "C123", "im"],
  ] as const)("handles typeless app_mention: %s", async (mode, channel, channelType) => {
    const { ctx, handler, handleSlackMessage } = createHandlers("app_mention", { channelType });
    const resolveChannelName = vi.spyOn(ctx, "resolveChannelName");
    if (mode === "remembered MPIM") {
      ctx.recallSlackChannelType = () => "mpim";
      resolveChannelName.mockResolvedValue({ type: "channel" });
    } else if (mode === "lookup failure") {
      resolveChannelName.mockResolvedValue({ lookupFailureCategory: "other" });
    }
    await handler({
      event: { ...makeAppMentionEvent(channel), channel_type: undefined },
      body: {},
    });
    if (mode === "group") {
      expect(handleSlackMessage).toHaveBeenCalledOnce();
      expect(handleSlackMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "G123" }),
        expect.objectContaining({ source: "app_mention", wasMentioned: true }),
      );
    } else {
      expect(handleSlackMessage).not.toHaveBeenCalled();
      expect(inboundLogLines()).toEqual([]);
    }
    if (mode === "remembered MPIM") {
      expect(resolveChannelName).not.toHaveBeenCalled();
    } else if (mode === "lookup failure") {
      expect(inboundInfoSpy).toHaveBeenCalledWith(
        "Slack app_mention skipped: conversation type unresolved; channelId=C123 lookupFailureCategory=other; waiting for message event",
        { channelId: "C123", lookupFailureCategory: "other" },
      );
      expect(JSON.stringify(inboundInfoSpy.mock.calls)).not.toMatch(/private|hello/);
    }
  });

  it.each([
    [
      "text",
      "Inbound app_mention slack:T_TEST:channel:C123:user:U1 -> bot:U_BOT (channel, 0 chars)",
    ],
    [
      "user",
      "Inbound app_mention slack:T_TEST:channel:C123:user:unknown -> bot:U_BOT (channel, 14 chars)",
    ],
  ])("logs channel app_mention receipts when %s is absent", async (field, receipt) => {
    const handleSlackMessage = await dispatch("app_mention", {
      ...makeAppMentionEvent(),
      [field]: undefined,
    });
    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(inboundLogLines()).toEqual([receipt]);
  });
});
