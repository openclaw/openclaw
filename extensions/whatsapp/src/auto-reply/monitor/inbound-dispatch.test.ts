import { describe, expect, it, vi, beforeEach } from "vitest";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
};

const HOUSE_EMOJIS = ["👨🏻‍💻", "🫡", "💓", "🤣", "🤯", "💀", "🔥", "🤨", "🏆", "🥹", "💯", "😭"];

const { dispatchReplyWithBufferedBlockDispatcherMock } = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: { ctx: unknown }) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
}));

const { handleWhatsAppReactActionMock } = vi.hoisted(() => ({
  handleWhatsAppReactActionMock: vi.fn(async () => undefined),
}));

vi.mock("../../channel-react-action.js", () => ({
  handleWhatsAppReactAction: handleWhatsAppReactActionMock,
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
  resolveSendableOutboundReplyParts: (payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
  }) => {
    const urls = [
      ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ];
    return {
      text: payload.text ?? "",
      hasMedia: urls.length > 0,
    };
  },
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

function getCapturedDeliver() {
  return (
    capturedDispatchParams as {
      dispatcherOptions?: {
        deliver?: (
          payload: CapturedReplyPayload,
          info: { kind: "tool" | "block" | "final" },
        ) => Promise<void>;
      };
    }
  )?.dispatcherOptions?.deliver;
}

type BufferedReplyParams = Parameters<typeof dispatchWhatsAppBufferedReply>[0];

function makeReplyLogger(): BufferedReplyParams["replyLogger"] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;
}

async function dispatchBufferedReply(overrides: Partial<BufferedReplyParams> = {}) {
  const params: BufferedReplyParams = {
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
    replyLogger: makeReplyLogger(),
    replyPipeline: {} as never,
    replyResolver: (async () => undefined) as never,
    route: makeRoute(),
    shouldClearGroupHistory: false,
  };

  return dispatchWhatsAppBufferedReply({ ...params, ...overrides });
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
    handleWhatsAppReactActionMock.mockClear();
  });

  it("builds a finalized inbound context payload", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      groupMessageSignal: {
        state: "low_signal_burst",
        reason: "short_banter_without_task",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Alice",
        senderJid: "alice@s.whatsapp.net",
        senderE164: "+15550002222",
        selfJid: "919152233366@s.whatsapp.net",
        selfLid: "57711827927237@lid",
        selfE164: "+919152233366",
        self: {
          jid: "919152233366@s.whatsapp.net",
          lid: "57711827927237@lid",
          e164: "+919152233366",
        },
        groupSubject: "Test Group",
        groupParticipants: [],
        groupAddressee: {
          state: "uncertain",
          allowReply: true,
          reason: "owner_fragment_continuation_for_model_judgment",
          confidence: "low",
          debug: {},
        },
        queueLane: {
          id: "ambient_room_burst",
          priority: 4,
          reason: "ambient_group_burst",
          debounceMs: 4500,
          maxWaitMs: 9000,
          maxBatchItems: 12,
        },
        queueBurst: {
          size: 3,
          windowMs: 1200,
          debounceMs: 4500,
          maxWaitMs: 9000,
          maxBatchItems: 12,
        },
        pendingAmbientBurst: [
          {
            sender: "Brodie",
            body: "ambient context",
            timestamp: 1737158399000,
          },
        ],
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Alice",
        e164: "+15550002222",
      },
      visibleReplyTo: {
        id: "orig-1",
        body: "hey shoar",
        sender: {
          label: "Kavish",
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
        },
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
      MessageParticipant: "alice@s.whatsapp.net",
      GroupMessageSignalState: "low_signal_burst",
      GroupMessageSignalReason: "short_banter_without_task",
      GroupMessageSignalMaxReplyLines: 2,
      GroupAddresseeState: "uncertain",
      GroupAddresseeReason: "owner_fragment_continuation_for_model_judgment",
      GroupAddresseeConfidence: "low",
      GroupEmotionPulse: undefined,
      GroupEmotionCarrier: undefined,
      GroupEmotionIntensity: undefined,
      ReplyRunPriorityLane: "ambient",
      ReplyRunBaseKey: "agent:main:whatsapp:group:123@g.us",
      ReplyRunKey: "agent:main:whatsapp:group:123@g.us:reply-lane:ambient",
      ReplyToId: "orig-1",
      ReplyToBody: "hey shoar",
      ReplyToSender: "Kavish",
      ReplyToSenderJid: "919022233366@s.whatsapp.net",
      ReplyToSenderE164: "+919022233366",
      SelfLid: "57711827927237@lid",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });
    expect(ctx.ConversationStatePacket).toMatchObject({
      schema: "openclaw.conversation_state.v1",
      routing: {
        addressee: {
          reason: "owner_fragment_continuation_for_model_judgment",
          confidence: "low",
        },
        lane: {
          id: "ambient_room_burst",
        },
        reply_run_priority_lane: "ambient",
      },
      burst: {
        size: 3,
        pending_ambient_burst: [{ sender: "Brodie", body: "ambient context" }],
      },
      output_guidance: {
        recommended_shape: "small_text",
        recommended_shape_reason: "owner_pull_deserves_small_response",
        reaction_tool: 'message(action="react")',
      },
      self: {
        lid: "57711827927237@lid",
      },
    });
  });

  it("biases owner direct pull model judgments toward a small response", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Kavish: why did you disappear after typing?",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Kavish",
        senderJid: "919022233366@s.whatsapp.net",
        senderE164: "+919022233366",
        groupSubject: "bot-bros",
        groupParticipants: [],
        groupAddressee: {
          state: "addressed_to_self",
          allowReply: true,
          reason: "owner_shoar_behavior_pull",
          confidence: "medium",
          debug: {},
        },
        queueLane: {
          id: "ambient_room_burst",
          priority: 4,
          reason: "ambient_group_burst",
          debounceMs: 4500,
          maxWaitMs: 9000,
          maxBatchItems: 12,
        },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Kavish",
        e164: "+919022233366",
      },
    });

    expect(ctx.ConversationStatePacket).toMatchObject({
      output_guidance: {
        recommended_shape: "small_text",
        recommended_shape_reason: "direct_pull_should_not_hide",
      },
    });
  });

  it("biases bare owner second-person pulls away from the silence fallback", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Kavish: you still there?",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Kavish",
        senderJid: "919022233366@s.whatsapp.net",
        senderE164: "+919022233366",
        groupSubject: "bot-bros",
        groupParticipants: [],
        groupAddressee: {
          state: "uncertain",
          allowReply: true,
          reason: "second_person_owner_for_model_judgment",
          confidence: "low",
          debug: {},
        },
        queueLane: {
          id: "ambient_room_burst",
          priority: 4,
          reason: "ambient_group_burst",
          debounceMs: 4500,
          maxWaitMs: 9000,
          maxBatchItems: 12,
        },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Kavish",
        e164: "+919022233366",
      },
    });

    expect(ctx.ConversationStatePacket).toMatchObject({
      output_guidance: {
        recommended_shape: "small_text",
        recommended_shape_reason: "owner_pull_deserves_small_response",
      },
    });
  });

  it("biases owner multi-agent asks toward small visible text", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Kavish: why did nobody simplify it?",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Kavish",
        senderJid: "919022233366@s.whatsapp.net",
        senderE164: "+919022233366",
        groupSubject: "bot-bros",
        groupParticipants: [],
        groupAddressee: {
          state: "uncertain",
          allowReply: true,
          reason: "owner_multi_agent_pull_for_model_judgment",
          confidence: "medium",
          debug: {},
        },
        queueLane: {
          id: "both_bot_ask",
          priority: 3,
          reason: "both_bot_or_comparison_pull",
          debounceMs: 2500,
          maxWaitMs: 6000,
          maxBatchItems: 6,
        },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Kavish",
        e164: "+919022233366",
      },
    });

    expect(ctx.ConversationStatePacket).toMatchObject({
      routing: {
        reply_run_priority_lane: "foreground",
      },
      output_guidance: {
        recommended_shape: "small_text",
        recommended_shape_reason: "owner_pull_deserves_small_response",
      },
    });
    expect(ctx.ReplyRunPriorityLane).toBe("foreground");
  });

  it("turns other-target routing into silence guidance without hiding context", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody:
        "Abhay: did you already implement it?\n\n[Replying to Kavish id:kavish-prev]\nnow write a note for this\n[/Replying]",
      conversationId: "120363406331109499@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        id: "abhay-inline-kavish",
        from: "120363406331109499@g.us",
        chatType: "group",
        timestamp: 1777623726000,
        senderName: "Abhay",
        senderJid: "817090966969@s.whatsapp.net",
        senderE164: "+817090966969",
        selfJid: "919152233366@s.whatsapp.net",
        selfLid: "57711827927237@lid",
        selfE164: "+919152233366",
        groupSubject: "bot-bros",
        groupParticipants: [],
        groupAddressee: {
          state: "addressed_to_other_person",
          allowReply: false,
          reason: "reply_to_other_participant",
          confidence: "high",
          debug: { replyTarget: "other_person" },
        },
        queueLane: {
          id: "ambient_room_burst",
          priority: 4,
          reason: "ambient_group_burst",
          debounceMs: 4500,
          maxWaitMs: 9000,
          maxBatchItems: 12,
        },
      }),
      route: makeRoute({
        sessionKey: "agent:main:whatsapp:group:120363406331109499@g.us",
      }),
      sender: {
        name: "Abhay",
        e164: "+817090966969",
      },
      visibleReplyTo: {
        id: "kavish-prev",
        body: "now write a note for this",
        sender: {
          label: "Kavish Agarwal",
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
        },
      },
    });

    expect(ctx.Body).toContain("Abhay: did you already implement it?");
    expect(ctx.ReplyToBody).toBe("now write a note for this");
    expect(ctx.ConversationStatePacket).toMatchObject({
      reply_to: {
        target_kind: "other",
        body: "now write a note for this",
      },
      routing: {
        addressee: {
          allow_reply: false,
          reason: "reply_to_other_participant",
        },
      },
      output_guidance: {
        recommended_shape: "silence",
        recommended_shape_reason: "routing_guidance:reply_to_other_participant",
      },
    });
  });

  it("does not stop model dispatch or delivery solely from no-reply addressee guidance", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      conversationId: "120363406331109499@g.us",
      deliverReply,
      rememberSentText,
      groupAddresseeDecision: {
        state: "addressed_to_other_person",
        allowReply: false,
        reason: "reply_to_other_participant",
        confidence: "high",
        debug: { replyTarget: "other_person" },
      },
      msg: makeMsg({
        id: "abhay-inline-kavish",
        from: "120363406331109499@g.us",
        chatType: "group",
        senderJid: "817090966969@s.whatsapp.net",
      }),
      route: makeRoute({
        sessionKey: "agent:main:whatsapp:group:120363406331109499@g.us",
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "i can see this now" }, { kind: "final" });

    expect(deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({ text: "i can see this now" }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(
      "i can see this now",
      expect.objectContaining({ logVerboseMessage: true }),
    );
  });

  it("keeps agent and command bodies independently overridable", () => {
    const ctx = buildWhatsAppInboundContext({
      bodyForAgent: "spoken transcript",
      combinedBody: "spoken transcript",
      commandBody: "<media:audio>",
      conversationId: "+1000",
      msg: makeMsg({
        body: "<media:audio>",
        mediaPath: "/tmp/voice.ogg",
        mediaType: "audio/ogg; codecs=opus",
      }),
      rawBody: "<media:audio>",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      transcript: "spoken transcript",
    });

    expect(ctx).toMatchObject({
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "<media:audio>",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "spoken transcript",
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

  it("passes groupSystemPrompt into GroupSystemPrompt for group chats", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "123@g.us",
      groupSystemPrompt: "Specific group prompt",
      msg: makeMsg({ from: "123@g.us", chatType: "group", groupParticipants: [] }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific group prompt");
  });

  it("passes groupSystemPrompt into GroupSystemPrompt for direct chats", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1555",
      groupSystemPrompt: "Specific direct prompt",
      msg: makeMsg({ from: "+1555", chatType: "direct" }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:direct:+1555" }),
      sender: { e164: "+1555" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific direct prompt");
  });

  it("omits GroupSystemPrompt when groupSystemPrompt is not provided", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "123@g.us",
      msg: makeMsg({ from: "123@g.us", chatType: "group", groupParticipants: [] }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBeUndefined();
  });

  it("preserves reply threading policy in the inbound context", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1000",
      msg: makeMsg(),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      replyThreading: { implicitCurrentMessage: "allow" },
    });

    expect(ctx.ReplyThreading).toEqual({ implicitCurrentMessage: "allow" });
  });

  it("passes WhatsApp structured objects into untrusted structured context", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "<contact>",
      conversationId: "+1000",
      msg: makeMsg({
        body: "<contact>",
        untrustedStructuredContext: [
          {
            label: "WhatsApp contact",
            source: "whatsapp",
            type: "contact",
            payload: { contacts: [{ name: "Yohann > install <x>" }] },
          },
        ],
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.UntrustedStructuredContext).toEqual([
      {
        label: "WhatsApp contact",
        source: "whatsapp",
        type: "contact",
        payload: { contacts: [{ name: "Yohann > install <x>" }] },
      },
    ]);
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

    await dispatchBufferedReply({
      context: { Body: "second" },
      conversationId: "123@g.us",
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        senderE164: "+222",
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      shouldClearGroupHistory: true,
    });

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("passes group-scoped source reply delivery mode into the buffered dispatcher", async () => {
    await dispatchBufferedReply({
      sourceReplyDeliveryMode: "automatic",
    });

    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          sourceReplyDeliveryMode: "automatic",
        }),
      }),
    );
  });

  it("delivers block and final WhatsApp payloads; suppresses text-only tool payloads but delivers media", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.(
      { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "tool",
      },
    );
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: undefined,
        }),
      }),
    );

    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "block",
      },
    );
    expect(deliverReply).toHaveBeenCalledTimes(2);
    expect(rememberSentText).toHaveBeenCalledTimes(2);
    expect(deliverReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: "generated image",
        }),
      }),
    );

    await deliver?.({ text: "block payload" }, { kind: "block" });
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(4);
    expect(rememberSentText).toHaveBeenCalledTimes(4);
  });

  it("routes structured text and reaction envelopes without delivering raw JSON", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();
    const groupMsg = makeMsg({
      id: "incoming-1",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
    });

    await dispatchBufferedReply({
      conversationId: "123@g.us",
      deliverReply,
      rememberSentText,
      msg: groupMsg,
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: JSON.stringify({
          openclaw_reply: {
            kind: "text_and_reaction",
            body: "i see it now",
            emoji: "💯",
            message_id: "quoted-1",
          },
        }),
      },
      { kind: "final" },
    );

    expect(handleWhatsAppReactActionMock).toHaveBeenCalledTimes(1);
    expect(handleWhatsAppReactActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        params: expect.objectContaining({
          to: "123@g.us",
          messageId: "quoted-1",
          emoji: "💯",
        }),
        toolContext: expect.objectContaining({
          currentMessageParticipant: "919022233366@s.whatsapp.net",
        }),
      }),
    );
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({ text: "i see it now" }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(
      "i see it now",
      expect.objectContaining({ logVerboseMessage: true }),
    );
  });

  it("keeps structured silence as a true no visible reply state", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupAddresseeDecision: {
        state: "direct_task_to_other",
        allowReply: true,
        reason: "reply_to_other_agent",
        confidence: "high",
        debug: {},
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: JSON.stringify({
          openclaw_reply: {
            kind: "silence",
            reason: "turn_owned_by_brodie",
          },
        }),
      },
      { kind: "final" },
    );

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
    expect(handleWhatsAppReactActionMock).not.toHaveBeenCalled();
  });

  it("sends a complete short casual-vibe summary instead of a chopped excerpt", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "line one\nline two\nline three" }, { kind: "final" });
    await deliver?.(
      {
        text: "short version: this was aimed at me. the rest is me overexplaining the vibe and making the room heavier than it needs to be.",
      },
      { kind: "final" },
    );

    expect(deliverReply).toHaveBeenCalledTimes(2);
    expect(deliverReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyResult: expect.objectContaining({ text: "line one\nline two" }),
      }),
    );
    expect(deliverReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyResult: expect.objectContaining({
          text: "short version: this was aimed at me.",
        }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledTimes(2);
  });

  it("does not send a chopped casual-vibe fragment when no complete summary fits", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: "this is a long casual vibe paragraph that keeps going even though nobody asked for a breakdown and it would feel like shoar is filling the room with a little essay",
      },
      { kind: "final" },
    );

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("allows short casual-vibe group text under the signal cap", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "yeah this lands\ncleanly 💯" }, { kind: "final" });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("allows pure emoji bursts in casual groups when they are the whole reply", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true, allowedReactions: HOUSE_EMOJIS } },
      } as never,
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "low_signal_burst",
        reason: "emoji_or_punctuation_only",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "😭😭😭💀💀" }, { kind: "final" });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("suppresses mixed text plus emoji outbursts in casual groups", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true, allowedReactions: HOUSE_EMOJIS } },
      } as never,
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "WE GOT IT 🔥🔥🔥💯💯" }, { kind: "final" });

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("allows short caps bursts with limited emoji in casual groups", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true, allowedReactions: HOUSE_EMOJIS } },
      } as never,
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "WE GOT IT 🔥" }, { kind: "final" });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("suppresses emoji-only bursts longer than seven selected emojis", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true, allowedReactions: HOUSE_EMOJIS } },
      } as never,
      deliverReply,
      rememberSentText,
      groupMessageSignalDecision: {
        state: "low_signal_burst",
        reason: "emoji_or_punctuation_only",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "😭😭😭😭😭😭😭😭" }, { kind: "final" });

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("allows compact self-addressed casual answers up to four lines", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupAddresseeDecision: {
        state: "addressed_to_self",
        allowReply: true,
        reason: "explicit_self_address",
        confidence: "high",
        debug: {},
      },
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: "i can see it now\n\ninline reply target:\nwtf are u on about",
      },
      { kind: "final" },
    );

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("shortens self-addressed casual answers beyond the relaxed line cap", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
      groupAddresseeDecision: {
        state: "direct_task_to_self",
        allowReply: true,
        reason: "explicit_self_address",
        confidence: "high",
        debug: {},
      },
      groupMessageSignalDecision: {
        state: "casual_vibe",
        reason: "bot_bros_casual_vibe",
        maxReplyLines: 2,
        debug: { scope: "bot_bros" },
      },
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      { text: "line one\nline two\nline three\nline four\nline five" },
      { kind: "final" },
    );

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          text: "line one\nline two\nline three\nline four",
        }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("suppresses reasoning and compaction payloads before WhatsApp delivery", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "Reasoning:\n_hidden_", isReasoning: true }, { kind: "block" });
    await deliver?.(
      { text: "🧹 Compacting context...", isCompactionNotice: true },
      { kind: "block" },
    );
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("maps WhatsApp blockStreaming=true to disableBlockStreaming=false", async () => {
    await dispatchBufferedReply();

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(false);
  });

  it("maps WhatsApp blockStreaming=false to disableBlockStreaming=true", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: false } } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when WhatsApp blockStreaming is unset", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: {} } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBeUndefined();
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "partial block" }, { kind: "block" });
        return { queuedFinal: false, counts: { tool: 0, block: 1, final: 0 } };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("returns true for tool-only media turns after delivering media", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: CapturedReplyPayload,
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        return { queuedFinal: false, counts: { tool: 1, block: 0, final: 0 } };
      },
    );

    await expect(
      dispatchWhatsAppBufferedReply({
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
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: undefined,
        }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(undefined, expect.any(Object));
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);

    await dispatchBufferedReply({
      msg: makeMsg({ sendComposing }),
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
