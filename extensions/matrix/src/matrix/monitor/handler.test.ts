import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../../../../src/infra/outbound/session-binding-service.js";
import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);

vi.mock("../send.js", () => ({
  reactMatrixMessage: vi.fn(async () => {}),
  sendMessageMatrix: sendMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: vi.fn(async () => {}),
}));

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  setMatrixRuntime({
    channel: {
      mentions: {
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((pattern) => pattern.test(text)),
      },
      media: {
        saveMediaBuffer: vi.fn(),
      },
    },
    config: {
      loadConfig: () => ({}),
    },
    state: {
      resolveStateDir: () => "/tmp",
    },
  } as never);
});

function createReactionHarness(params?: {
  cfg?: unknown;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  storeAllowFrom?: string[];
  targetSender?: string;
  isDirectMessage?: boolean;
  senderName?: string;
}) {
  return createMatrixHandlerTestHarness({
    cfg: params?.cfg,
    dmPolicy: params?.dmPolicy,
    allowFrom: params?.allowFrom,
    readAllowFromStore: vi.fn(async () => params?.storeAllowFrom ?? []),
    client: {
      getEvent: async () => ({ sender: params?.targetSender ?? "@bot:example.org" }),
    },
    isDirectMessage: params?.isDirectMessage,
    getMemberDisplayName: async () => params?.senderName ?? "sender",
  });
}

describe("matrix monitor handler pairing account scope", () => {
  it("caches account-scoped allowFrom store reads on hot path", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    sendMessageMatrixMock.mockClear();

    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      dmPolicy: "pairing",
      buildPairingReply: () => "pairing",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event1",
        body: "@room hello",
        mentions: { room: true },
      }),
    );

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event2",
        body: "@room hello again",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
  });

  it("refreshes the account-scoped allowFrom cache after its ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      const { handler } = createMatrixHandlerTestHarness({
        readAllowFromStore,
        dmPolicy: "pairing",
        buildPairingReply: () => "pairing",
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          eventId: id,
          body: "@room hello",
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(readAllowFromStore).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_001);
      await handler("!room:example.org", makeEvent("$event3"));

      expect(readAllowFromStore).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends pairing reminders for pending requests with cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      sendMessageMatrixMock.mockClear();

      const { handler } = createMatrixHandlerTestHarness({
        readAllowFromStore,
        dmPolicy: "pairing",
        buildPairingReply: () => "Pairing code: ABCDEFGH",
        isDirectMessage: true,
        getMemberDisplayName: async () => "sender",
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          eventId: id,
          body: "hello",
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(String(sendMessageMatrixMock.mock.calls[0]?.[1] ?? "")).toContain(
        "Pairing request is still pending approval.",
      );

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await handler("!room:example.org", makeEvent("$event3"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses account-scoped pairing store reads and upserts for dm pairing", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "ABCDEFGH", created: false }));

    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      upsertPairingRequest,
      dmPolicy: "pairing",
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
      dropPreStartupMessages: true,
      needsRoomAliasesForConfig: false,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event1",
        body: "hello",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "matrix",
      env: process.env,
      accountId: "ops",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "matrix",
      id: "@user:example.org",
      accountId: "ops",
      meta: { name: "sender" },
    });
  });

  it("passes accountId into route resolution for inbound dm messages", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));

    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event2",
        body: "hello",
        mentions: { room: true },
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        accountId: "ops",
      }),
    );
  });

  it("does not enqueue delivered text messages into system events", async () => {
    const dispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }));
    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig,
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event-system-preview",
        body: "hello from matrix",
        mentions: { room: true },
      }),
    );

    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops forged metadata-only mentions before agent routing", async () => {
    const { handler, recordInboundSession, resolveAgentRoute } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$spoofed-mention",
        body: "hello there",
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("skips media downloads for unmentioned group media messages", async () => {
    const downloadContent = vi.fn(async () => Buffer.from("image"));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler, resolveAgentRoute } = createMatrixHandlerTestHarness({
      client: {
        downloadContent,
      },
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName,
      getRoomInfo,
    });

    await handler("!room:example.org", {
      type: EventType.RoomMessage,
      sender: "@user:example.org",
      event_id: "$media1",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.image",
        body: "",
        url: "mxc://example.org/media",
        info: {
          mimetype: "image/png",
          size: 5,
        },
      },
    } as MatrixRawEvent);

    expect(downloadContent).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("skips poll snapshot fetches for unmentioned group poll responses", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$poll",
      sender: "@user:example.org",
      type: "m.poll.start",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    }));
    const getRelations = vi.fn(async () => ({
      events: [],
      nextBatch: null,
      prevBatch: null,
    }));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler, resolveAgentRoute } = createMatrixHandlerTestHarness({
      client: {
        getEvent,
        getRelations,
      },
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName,
      getRoomInfo,
    });

    await handler("!room:example.org", {
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$poll-response-1",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.response": {
          answers: ["a1"],
        },
        "m.relates_to": {
          rel_type: "m.reference",
          event_id: "$poll",
        },
      },
    } as MatrixRawEvent);

    expect(getEvent).not.toHaveBeenCalled();
    expect(getRelations).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("records thread starter context for inbound thread replies", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: "$root",
              sender: "@alice:example.org",
              body: "Root topic",
            }),
        },
        isDirectMessage: false,
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
        mentions: { room: true },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$root",
        ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("uses stable room ids instead of room-declared aliases in group context", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getRoomInfo: async () => ({
        name: "Ops Room",
        canonicalAlias: "#spoofed:example.org",
        altAliases: ["#alt:example.org"],
      }),
      getMemberDisplayName: async () => "sender",
      dispatchReplyFromConfig: async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$group1",
        body: "@room hello",
        mentions: { room: true },
      }),
    );

    const finalized = vi.mocked(finalizeInboundContext).mock.calls.at(-1)?.[0];
    expect(finalized).toEqual(
      expect.objectContaining({
        GroupSubject: "Ops Room",
        GroupId: "!room:example.org",
      }),
    );
    expect(finalized).not.toHaveProperty("GroupChannel");
  });

  it("routes bound Matrix threads to the target session key", async () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example:$root",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "$root",
                parentConversationId: "!room:example",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch: vi.fn(),
    });
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@alice:example.org",
            body: "Root topic",
          }),
      },
      isDirectMessage: false,
      finalizeInboundContext: (ctx: unknown) => ctx,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
        mentions: { room: true },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:bound:session-1",
      }),
    );
  });

  it("does not enqueue system events for delivered text replies", async () => {
    const enqueueSystemEvent = vi.fn();

    const handler = createMatrixRoomMessageHandler({
      client: {
        getUserId: async () => "@bot:example.org",
      } as never,
      core: {
        channel: {
          pairing: {
            readAllowFromStore: async () => [] as string[],
            upsertPairingRequest: async () => ({ code: "ABCDEFGH", created: false }),
            buildPairingReply: () => "pairing",
          },
          commands: {
            shouldHandleTextCommands: () => false,
          },
          text: {
            hasControlCommand: () => false,
            resolveMarkdownTableMode: () => "preserve",
          },
          routing: {
            resolveAgentRoute: () => ({
              agentId: "ops",
              channel: "matrix",
              accountId: "ops",
              sessionKey: "agent:ops:main",
              mainSessionKey: "agent:ops:main",
              matchedBy: "binding.account",
            }),
          },
          session: {
            resolveStorePath: () => "/tmp/session-store",
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: vi.fn(async () => {}),
          },
          reply: {
            resolveEnvelopeFormatOptions: () => ({}),
            formatAgentEnvelope: ({ body }: { body: string }) => body,
            finalizeInboundContext: (ctx: unknown) => ctx,
            createReplyDispatcherWithTyping: () => ({
              dispatcher: {},
              replyOptions: {},
              markDispatchIdle: () => {},
            }),
            resolveHumanDelayConfig: () => undefined,
            dispatchReplyFromConfig: async () => ({
              queuedFinal: true,
              counts: { final: 1, block: 0, tool: 0 },
            }),
          },
          reactions: {
            shouldAckReaction: () => false,
          },
        },
        system: {
          enqueueSystemEvent,
        },
      } as never,
      cfg: {} as never,
      accountId: "ops",
      runtime: {
        error: () => {},
      } as never,
      logger: {
        info: () => {},
        warn: () => {},
      } as never,
      logVerboseMessage: () => {},
      allowFrom: [],
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "off",
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 8_000,
      mediaMaxBytes: 10_000_000,
      startupMs: 0,
      startupGraceMs: 0,
      dropPreStartupMessages: false,
      directTracker: {
        isDirectMessage: async () => false,
      },
      getRoomInfo: async () => ({ altAliases: [] }),
      getMemberDisplayName: async () => "sender",
      needsRoomAliasesForConfig: false,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$message1",
        sender: "@user:example.org",
        body: "hello there",
        mentions: { room: true },
      }) as MatrixRawEvent,
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues system events for reactions on bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness();

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction1",
        targetEventId: "$msg1",
        key: "👍",
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        accountId: "ops",
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by sender on msg $msg1",
      {
        sessionKey: "agent:ops:main",
        contextKey: "matrix:reaction:add:!room:example.org:$msg1:@user:example.org:👍",
      },
    );
  });

  it("routes reaction notifications for bound thread messages to the bound session", async () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example.org:$root",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "$root",
                parentConversationId: "!room:example.org",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch: vi.fn(),
    });

    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$reply1",
            sender: "@bot:example.org",
            body: "follow up",
            relatesTo: {
              rel_type: "m.thread",
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
            },
          }),
      },
      isDirectMessage: false,
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-thread",
        targetEventId: "$reply1",
        key: "🎯",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🎯 by sender on msg $reply1",
      {
        sessionKey: "agent:bound:session-1",
        contextKey: "matrix:reaction:add:!room:example.org:$reply1:@user:example.org:🎯",
      },
    );
  });

  it("ignores reactions that do not target bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness({
      targetSender: "@other:example.org",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction2",
        targetEventId: "$msg2",
        key: "👀",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("does not create pairing requests for unauthorized dm reactions", async () => {
    const { handler, enqueueSystemEvent, upsertPairingRequest } = createReactionHarness({
      dmPolicy: "pairing",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction3",
        targetEventId: "$msg3",
        key: "🔥",
      }),
    );

    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("honors account-scoped reaction notification overrides", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            reactionNotifications: "own",
            accounts: {
              ops: {
                reactionNotifications: "off",
              },
            },
          },
        },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction4",
        targetEventId: "$msg4",
        key: "✅",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops pre-startup dm messages on cold start", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));
    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      startupMs: 1_000,
      startupGraceMs: 0,
      dropPreStartupMessages: true,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$old-cold-start",
        body: "hello",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("replays pre-startup dm messages when persisted sync state exists", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));
    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      startupMs: 1_000,
      startupGraceMs: 0,
      dropPreStartupMessages: false,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$old-resume",
        body: "hello",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });
});
