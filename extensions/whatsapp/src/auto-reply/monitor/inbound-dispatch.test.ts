import { describe, expect, it, vi, beforeEach } from "vitest";

let capturedDispatchParams: unknown;

const { dispatchReplyWithBufferedBlockDispatcherMock } = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: { ctx: unknown }) => {
    capturedDispatchParams = params;
    return { queuedFinal: false };
  }),
}));

vi.mock("./runtime-api.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
  finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ({
    ...ctx,
    BodyForCommands:
      typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.BodyForAgent === "string"
          ? ctx.BodyForAgent
          : "",
  }),
  getAgentScopedMediaLocalRoots: () => [],
  jidToE164: (value: string) => {
    const phone = value.split("@")[0]?.replace(/[^\d]/g, "");
    return phone ? `+${phone}` : null;
  },
  logVerbose: () => {},
  resolveChunkMode: () => "length",
  resolveIdentityNamePrefix: (cfg: {
    agents?: { list?: Array<{ id?: string; default?: boolean; identity?: { name?: string } }> };
  }) => {
    const agent = cfg.agents?.list?.find((entry) => entry.default) ?? cfg.agents?.list?.[0];
    const name = agent?.identity?.name?.trim();
    return name ? `[${name}]` : undefined;
  },
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveMarkdownTableMode: () => undefined,
  resolveSendableOutboundReplyParts: (payload: { text?: string }) => ({
    text: payload.text ?? "",
    hasMedia: false,
  }),
  resolveTextChunkLimit: () => 4000,
  shouldLogVerbose: () => false,
  toLocationContext: () => ({}),
}));

import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof buildWhatsAppInboundContext>[0]["route"];
type TestMsg = Parameters<typeof buildWhatsAppInboundContext>[0]["msg"];

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    channel: "whatsapp",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:direct:+1000",
    mainSessionKey: "agent:main:whatsapp:direct:+1000",
    lastRoutePolicy: "main",
    matchedBy: "default",
    ...overrides,
  };
}

function makeMsg(overrides: Partial<TestMsg> = {}): TestMsg {
  return {
    id: "msg1",
    from: "+1000",
    to: "+2000",
    conversationId: "+1000",
    accountId: "default",
    chatId: "+1000",
    chatType: "direct",
    body: "hi",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
  });

  it("builds a finalized inbound context payload", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Alice",
        senderJid: "alice@s.whatsapp.net",
        senderE164: "+15550002222",
        groupSubject: "Test Group",
        groupParticipants: [],
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Alice",
        e164: "+15550002222",
      },
    });

    expect(ctx).toMatchObject({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      Timestamp: 1737158400000,
      SenderId: "+15550002222",
      SenderE164: "+15550002222",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });
  });

  it("falls back SenderId to SenderE164 when sender id is missing", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1000",
      msg: makeMsg({
        senderJid: "",
        senderE164: "+1000",
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.To).toBe("+2000");
  });

  it("defaults responsePrefix to identity name in self-chats when unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
            },
          ],
        },
        messages: {},
      } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBe("[Mainbot]");
  });

  it("does not force a response prefix in self-chats when identity is unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: { messages: {} } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBeUndefined();
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>([
      ["whatsapp:default:group:123@g.us", [{ sender: "Alice (+111)", body: "first" }]],
    ]);

    await dispatchWhatsAppBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
      connectionId: "conn",
      context: { Body: "second" },
      conversationId: "123@g.us",
      deliverReply: async () => {},
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      maxMediaBytes: 1,
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        senderE164: "+222",
      }),
      rememberSentText: () => {},
      replyLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      replyPipeline: {},
      replyResolver: (async () => undefined) as never,
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      shouldClearGroupHistory: true,
    });

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("suppresses non-final WhatsApp payload delivery", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchWhatsAppBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
      connectionId: "conn",
      context: { Body: "hi" },
      conversationId: "+1000",
      deliverReply,
      groupHistories: new Map(),
      groupHistoryKey: "+1000",
      maxMediaBytes: 1,
      msg: makeMsg(),
      rememberSentText,
      replyLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      replyPipeline: {},
      replyResolver: (async () => undefined) as never,
      route: makeRoute(),
      shouldClearGroupHistory: false,
    });

    const deliver = (
      capturedDispatchParams as {
        dispatcherOptions?: {
          deliver?: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }
    )?.dispatcherOptions?.deliver;

    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    await deliver?.({ text: "block payload" }, { kind: "block" });
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("forces disableBlockStreaming for WhatsApp dispatch", async () => {
    await dispatchWhatsAppBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
      connectionId: "conn",
      context: { Body: "hi" },
      conversationId: "+1000",
      deliverReply: async () => {},
      groupHistories: new Map(),
      groupHistoryKey: "+1000",
      maxMediaBytes: 1,
      msg: makeMsg(),
      rememberSentText: () => {},
      replyLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      replyPipeline: {},
      replyResolver: (async () => undefined) as never,
      route: makeRoute(),
      shouldClearGroupHistory: false,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(true);
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);

    await dispatchWhatsAppBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
      connectionId: "conn",
      context: { Body: "hi" },
      conversationId: "+1000",
      deliverReply: async () => {},
      groupHistories: new Map(),
      groupHistoryKey: "+1000",
      maxMediaBytes: 1,
      msg: makeMsg({ sendComposing }),
      rememberSentText: () => {},
      replyLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      replyPipeline: {},
      replyResolver: (async () => undefined) as never,
      route: makeRoute(),
      shouldClearGroupHistory: false,
    });

    expect(
      (
        capturedDispatchParams as {
          dispatcherOptions?: { onReplyStart?: unknown };
        }
      )?.dispatcherOptions?.onReplyStart,
    ).toBe(sendComposing);
  });

  it("updates main last route for DM when session key matches main session key", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: null,
      route: makeRoute(),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("does not update main last route for isolated DM scope sessions", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: null,
      route: makeRoute({
        sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
        mainSessionKey: "agent:main:whatsapp:direct:+1000",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("does not update main last route for non-owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("updates main last route for owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("resolves DM route targets from the sender first and the chat JID second", () => {
    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        senderE164: "+15550002222",
        normalizeE164: (value) => value,
      }),
    ).toBe("+15550002222");

    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        normalizeE164: () => null,
      }),
    ).toBe("+15550003333");
  });
});
