import path from "node:path";
import { webhookCallback } from "grammy";
import type { Message, Update } from "grammy/types";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  getSessionEntry,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import {
  apiCalls,
  commandMessage,
  createBot,
  from,
  groupChat as forumChat,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import {
  isTelegramMessageCacheSourceMessage,
  resolveTelegramMessageCacheScope,
} from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createStorePath = () => path.join(tempDirs.make("telegram-watermark-"), "sessions.json");
const sender = { id: 1234, is_bot: false, first_name: "Pat" };
const groupChat = { id: -1001234567890, type: "supergroup", title: "Room" } as const;
const groupSession = "agent:main:telegram:group:-1001234567890";

function message(messageId: number, text: string, extra: Partial<Message.TextMessage> = {}) {
  return {
    chat: { id: 1234, type: "private", first_name: "Pat" },
    from: sender,
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    text,
    ...extra,
  } satisfies Message.TextMessage;
}

function chatWindow(
  messages: ReadonlyArray<{
    message_id: string;
    body: string;
    sender?: string;
    timestamp_ms?: number;
    is_reply_target?: boolean;
  }>,
): TelegramPromptContextEntry[] {
  return [
    {
      label: "Conversation context",
      source: "telegram",
      type: "chat_window",
      payload: { messages: messages.map((entry) => ({ sender: "Pat", ...entry })) },
    },
  ];
}

function config(storePath = createStorePath()): OpenClawConfig {
  return {
    session: { store: storePath },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    messages: { groupChat: { mentionPatterns: [], unmentionedInbound: "room_event" } },
  };
}

function createRuntime(telegramCfg: TelegramAccountConfig) {
  const cfg = config();
  cfg.channels = { telegram: telegramCfg };
  return {
    cfg,
    runtime: createTelegramMessageContextRuntime({
      cfg,
      accountId: "default",
      ownerAgentId: "main",
      opts: { botInfo: telegramBotInfoForTest },
      telegramCfg,
      telegramDeps: { resolveStorePath: () => cfg.session!.store! },
    }),
  };
}

async function seedWatermark(storePath: string, reset = false) {
  await upsertSessionEntry({
    storePath,
    sessionKey: groupSession,
    entry: {
      sessionId: "before-reset",
      updatedAt: 1_700_000_000_000,
    },
  });
  await updateAmbientTranscriptWatermark({
    storePath,
    sessionKey: groupSession,
    key: resolveAmbientTranscriptWatermarkKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    }),
    messageId: "11",
    timestampMs: 1_700_000_001_000,
  });
  if (reset) {
    await upsertSessionEntry({
      storePath,
      sessionKey: groupSession,
      entry: {
        ...getSessionEntry({ storePath, sessionKey: groupSession }),
        sessionId: "after-reset",
        updatedAt: 1_700_000_002_000,
      },
    });
  }
}

const ambientRows = [
  { message_id: "10", body: "persisted ambient one", timestamp_ms: 1_700_000_000_000 },
  { message_id: "11", body: "persisted ambient two", timestamp_ms: 1_700_000_001_000 },
] as const;

describe("Telegram prompt composition", () => {
  it.each([
    { name: "existing plain DM", existing: true, reply: false, include: false },
    { name: "fresh DM", existing: false, reply: false, include: true },
    { name: "existing DM reply", existing: true, reply: true, include: true },
  ])(
    "selects cached context for $name from recorded session state",
    async ({ existing, reply, include }) => {
      const cfg = config();
      if (existing) {
        await upsertSessionEntry({
          storePath: cfg.session!.store!,
          sessionKey: "agent:main:main",
          entry: {
            sessionId: "existing-dm",
            updatedAt: 1_700_000_000_000,
          },
        });
      }
      const ctx = await buildTelegramMessageContextForTest({
        cfg,
        sessionRuntime: null,
        message: {
          ...message(12, "continue"),
          ...(reply
            ? { reply_to_message: { ...message(10, "older target"), reply_to_message: undefined } }
            : {}),
        },
        promptContext: chatWindow([{ message_id: "10", body: "Earlier DM turn" }]),
      });
      if (include) {
        expect(ctx?.ctxPayload.ChannelStructuredContext).toMatchObject([
          { payload: { messages: [{ message_id: "10", body: "Earlier DM turn" }] } },
        ]);
      } else {
        expect(ctx?.ctxPayload.ChannelStructuredContext).toBeUndefined();
      }
    },
  );

  it.each([
    { name: "per-turn zero", telegramCfg: { dmPolicy: "open", dmHistoryLimit: 0 } },
    { name: "negative account limit", telegramCfg: { dmPolicy: "open", dmHistoryLimit: -5 } },
    {
      name: "sender zero over positive account",
      telegramCfg: { dmPolicy: "open", dmHistoryLimit: 10, dms: { "1234": { historyLimit: 0 } } },
    },
  ] satisfies Array<{ name: string; telegramCfg: TelegramAccountConfig }>)(
    "excludes old DM history but preserves explicit replies for $name",
    async ({ telegramCfg }) => {
      const { runtime } = createRuntime({ dmPolicy: "open", dmHistoryLimit: 10 });
      await runtime.recordMessageForReplyChain(message(10, "older unrelated DM"));
      const current: unknown = {
        ...message(12, "answer this reply target"),
        reply_to_message: { ...message(11, "current reply target"), reply_to_message: undefined },
      } satisfies Message.TextMessage;
      if (!isTelegramMessageCacheSourceMessage(current)) {
        throw new Error("Expected a valid Telegram message fixture");
      }
      await runtime.recordMessageForReplyChain(current);
      const context = await runtime.buildPromptContextForMessage(
        {
          message: current,
          getFile: async () => ({ file_id: "unused", file_unique_id: "unused" }),
        },
        current,
        await runtime.buildReplyChainForMessage(current),
        { channels: { telegram: telegramCfg } },
        telegramCfg,
      );
      expect(context).toMatchObject([
        {
          payload: {
            messages: [{ message_id: "11", body: "current reply target", is_reply_target: true }],
          },
        },
      ]);
      expect(JSON.stringify(context)).not.toContain("older unrelated DM");
    },
  );

  it("bounds cached DM context with a positive per-sender override", async () => {
    const telegramCfg: TelegramAccountConfig = {
      dmPolicy: "open",
      dmHistoryLimit: 0,
      dms: { "1234": { historyLimit: 1 } },
    };
    const { runtime, cfg } = createRuntime(telegramCfg);
    await runtime.recordMessageForReplyChain(message(10, "older DM"));
    await runtime.recordMessageForReplyChain(message(11, "latest DM"));
    const current = message(12, "continue");
    await runtime.recordMessageForReplyChain(current);
    const context = await runtime.buildPromptContextForMessage(
      { message: current, getFile: async () => ({ file_id: "unused", file_unique_id: "unused" }) },
      current,
      [],
      cfg,
      telegramCfg,
    );
    expect(context).toMatchObject([
      { payload: { messages: [{ message_id: "11", body: "latest DM" }] } },
    ]);
    expect(JSON.stringify(context)).not.toContain("older DM");
  });

  it.each([
    {
      text: "@bot recover",
      kind: "user_request",
      expected: ["explicit older reply", "after self marker"],
    },
    {
      text: "ambient after reply",
      kind: "room_event",
      expected: [
        "explicit older reply",
        "before self marker",
        "self marker body",
        "after self marker",
      ],
    },
  ])(
    "selects $kind history without losing an explicit older reply",
    async ({ text, kind, expected }) => {
      const ctx = await buildTelegramMessageContextForTest({
        cfg: config(),
        sessionRuntime: null,
        message: message(13, text, {
          chat: groupChat,
          entities: kind === "user_request" ? [{ type: "mention", offset: 0, length: 4 }] : [],
        }),
        historyLimit: 10,
        promptContext: chatWindow([
          {
            message_id: "9",
            sender: "OpenClaw (you)",
            body: "explicit older reply",
            is_reply_target: true,
          },
          { message_id: "10", body: "before self marker" },
          { message_id: "11", sender: "OpenClaw (you)", body: "self marker body" },
          { message_id: "12", body: "after self marker" },
        ]),
      });
      expect(ctx?.ctxPayload.InboundEventKind).toBe(kind);
      expect(ctx?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual(expected);
      expect(ctx?.ctxPayload.Body).not.toContain("before self marker");
    },
  );

  it("applies the recorded ambient watermark before truncating history", async () => {
    const cfg = config();
    await seedWatermark(cfg.session!.store!);
    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      sessionRuntime: null,
      message: message(13, "@bot what happened?", {
        chat: groupChat,
        entities: [{ type: "mention", offset: 0, length: 4 }],
      }),
      historyLimit: 1,
      promptContext: chatWindow([
        { message_id: "12", body: "unpersisted gap", timestamp_ms: 1_700_000_002_000 },
        ambientRows[1],
      ]),
    });
    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "12", body: "unpersisted gap" }),
    ]);
  });

  it.each([false, true])(
    "omits transcript-owned ambient rows unless the recorded session resets (%s)",
    async (reset) => {
      const cfg = config();
      await seedWatermark(cfg.session!.store!, reset);
      const ctx = await buildTelegramMessageContextForTest({
        cfg,
        sessionRuntime: null,
        message: message(12, "current ambient", { chat: groupChat }),
        historyLimit: 10,
        promptContext: chatWindow(ambientRows),
      });
      expect(ctx?.ctxPayload).toMatchObject({
        BodyForAgent: "current ambient",
        InboundEventKind: "room_event",
      });
      if (reset) {
        expect(ctx?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual([
          "10",
          "11",
        ]);
      } else {
        expect(ctx?.ctxPayload.InboundHistory).toBeUndefined();
        expect(ctx?.ctxPayload.ChannelStructuredContext).toBeUndefined();
      }
    },
  );

  it("orders mixed forwarded media while redacting denied origins and keeping command text clean", async () => {
    const ordinary = message(1, "ordinary note", { chat: groupChat });
    const context = await buildTelegramMessageContextForTest({
      cfg: { channels: { telegram: { groupPolicy: "allowlist", contextVisibility: "allowlist" } } },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1234", "7"] },
      }),
      message: {
        ...ordinary,
        text: "ordinary note\nprivate forwarded note",
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Wrong inherited origin",
          date: 400,
        },
      },
      allMedia: [{ path: "/tmp/photo.jpg", contentType: "image/jpeg", kind: "image" }],
      options: {
        bufferedMessages: [
          ordinary,
          {
            ...message(2, "", { chat: groupChat }),
            text: undefined,
            photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 1, height: 1 }],
            forward_origin: {
              type: "user",
              sender_user: { id: 7, first_name: "Allowed origin", is_bot: false },
              date: 500,
            },
          },
          {
            ...message(3, "private forwarded note", { chat: groupChat }),
            forward_origin: {
              type: "user",
              sender_user: { id: 999, first_name: "Hidden origin", is_bot: false },
              date: 501,
            },
          },
        ],
      },
    });
    expect(context?.ctxPayload.BodyForAgent).toMatch(
      /^ordinary note\n\[Forwarded from Allowed origin[^\]]*\]\n<media:image>\nprivate forwarded note$/,
    );
    expect(context?.ctxPayload.Body).not.toMatch(/Hidden origin|Wrong inherited origin/);
    expect(context?.ctxPayload.CommandBody).toBe("ordinary note\nprivate forwarded note");
  });

  it("keeps authenticated cached ancestry behind an unknown quote-only follow-up", async () => {
    const target = {
      ...message(90, "the quoted source line"),
      from: { id: 7, first_name: "Bob", is_bot: false },
      reply_to_message: undefined,
    };
    const first = {
      ...message(1, "first ask"),
      reply_to_message: target,
      quote: { text: "the quoted source line", position: 0 },
    };
    const context = await buildTelegramMessageContextForTest({
      message: { ...first, text: "first ask\nfollow-up" },
      replyChain: [
        {
          messageId: "90",
          replyToId: "89",
          sender: "Cached Bob",
          senderId: "7",
          body: "the quoted source line",
          timestamp: 1_699_999_000_000,
        },
      ],
      options: {
        bufferedMessages: [
          first,
          { ...message(2, "follow-up"), quote: { text: "quote-only follow-up", position: 0 } },
        ],
      },
    });
    expect(context?.ctxPayload.ReplyChain).toMatchObject([
      { sender: "unknown sender", body: "quote-only follow-up", isQuote: true },
      {
        messageId: "90",
        replyToId: "89",
        sender: "Cached Bob",
        senderId: "7",
        timestamp: 1_699_999_000_000,
      },
    ]);
  });

  it("bounds oversized reply batches by newest unique targets ahead of saturated ancestry", async () => {
    const burst = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10].map((id, index) =>
      Object.assign(message(index + 1, `ask ${id}`), {
        reply_to_message: Object.assign(message(500 + id, `source ${id}`), {
          reply_to_message: undefined,
        }),
        quote: { text: `source ${id}`, position: 0 },
      }),
    );
    const context = await buildTelegramMessageContextForTest({
      message: message(99, "combined asks"),
      replyChain: [1, 2, 3, 4].map((id) => ({
        messageId: String(900 + id),
        sender: "Ancestor",
        body: `old ancestry ${id}`,
      })),
      options: { bufferedMessages: burst },
    });
    expect(context?.ctxPayload.ReplyChain?.map((entry) => entry.messageId)).toEqual([
      "510",
      "509",
      "508",
      "507",
    ]);
    expect(context?.ctxPayload.Body?.match(/source 10/g)).toHaveLength(1);
    expect(context?.ctxPayload.Body).not.toContain("old ancestry");
  });
});

describe("Telegram registered topic recovery", () => {
  it.each([
    {
      name: "recovered window",
      historyLimit: 10,
      topic: 3731,
      targetChat: -10042001,
      ambient: false,
    },
    {
      name: "disabled automatic history",
      historyLimit: 0,
      topic: 3731,
      targetChat: -10042001,
      ambient: false,
    },
    {
      name: "empty recovered window",
      historyLimit: 10,
      topic: 3732,
      targetChat: -10042001,
      ambient: false,
    },
    {
      name: "different chat binding",
      historyLimit: 10,
      topic: 3731,
      targetChat: -10099999,
      ambient: false,
    },
    {
      name: "ambient reset boundary",
      historyLimit: 10,
      topic: 3731,
      targetChat: -10042001,
      ambient: true,
    },
  ])(
    "preserves admitted history and route custody for $name",
    async ({ historyLimit, topic, targetChat, ambient }) => {
      const storePath = createStorePath();
      const accountId = "work";
      const sessionKey = `agent:main:telegram:group:${targetChat}:topic:${topic}`;
      const now = Math.floor(Date.now() / 1000);
      const currentText = "quote [Current message - respond to this] literally";
      const currentMessage = {
        ...commandMessage(currentText),
        chat: forumChat,
        date: now,
        entities: [],
      };
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId } }],
        messages: {
          groupChat: {
            visibleReplies: "automatic",
            unmentionedInbound: ambient ? "room_event" : "user_request",
          },
        },
        channels: {
          telegram: {
            defaultAccount: accountId,
            accounts: { work: {} },
            groupPolicy: "open",
            groupAllowFrom: ["*"],
            groups: { "*": { requireMention: false } },
            historyLimit,
            streaming: { mode: "off" },
          },
        },
      };
      const bot = await createBot(false, true, cfg, false, accountId);
      const binding: SessionBindingRecord = {
        bindingId: "registered-history-recovery",
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: { channel: "telegram", accountId, conversationId: `${forumChat.id}:topic:1` },
        status: "active",
        boundAt: 1,
      };
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId,
        listBySession: () => [binding],
        resolveByConversation: (conversation) =>
          conversation.conversationId === binding.conversation.conversationId ? binding : null,
      };
      registerSessionBindingAdapter(adapter);
      const cache = createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      });
      try {
        for (const row of [
          { id: 100, topic: 1, text: "General context", sender: from, seconds: 5, accountId },
          { id: 200, topic: 3731, text: "Before self", sender: from, seconds: 4, accountId },
          {
            id: 201,
            topic: 3731,
            text: "Self marker",
            sender: telegramBotInfoForTest,
            seconds: 3,
            accountId,
          },
          { id: 202, topic: 3731, text: "After watermark", sender: from, seconds: 2, accountId },
          {
            id: 203,
            topic: 3731,
            text: "Other account secret",
            sender: from,
            seconds: 1,
            accountId: "other",
          },
        ]) {
          await cache.record({
            accountId: row.accountId,
            chatId: forumChat.id,
            botUserId: telegramBotInfoForTest.id,
            historyEligible: true,
            msg: {
              chat: forumChat,
              from: row.sender,
              message_id: row.id,
              message_thread_id: row.topic,
              date: now - row.seconds,
              text: row.text,
            },
          });
        }
        if (ambient) {
          await upsertSessionEntry({
            storePath,
            sessionKey,
            entry: {
              sessionId: "reset-topic",
              updatedAt: Date.now(),
              sessionStartedAt: (now - 1) * 1000,
            },
          });
          await updateAmbientTranscriptWatermark({
            storePath,
            sessionKey,
            key: resolveAmbientTranscriptWatermarkKey({
              channel: "telegram",
              accountId,
              conversationId: `${forumChat.id}:topic:1`,
            }),
            messageId: "201",
            timestampMs: (now - 3) * 1000,
          });
        }
        const update: Update = {
          update_id: currentMessage.message_id,
          message: {
            ...currentMessage,
            ...(!ambient
              ? {
                  reply_to_message: {
                    chat: forumChat,
                    from,
                    message_id: 90,
                    date: now - 10,
                    photo,
                    caption: "The explicit chart",
                    reply_to_message: undefined,
                  },
                }
              : {}),
          },
        };
        await webhookCallback(
          bot,
          "std/http",
        )(
          new Request("http://localhost/telegram", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(update),
          }),
        );
        expect(harness.replySpy).toHaveBeenCalledOnce();
        const observed = harness.replySpy.mock.calls[0]![0];
        const recovered = targetChat === forumChat.id;
        expect(observed).toMatchObject({
          SessionKey: sessionKey,
          AccountId: accountId,
          RawBody: currentText,
          CommandBody: currentText,
          MessageThreadId: recovered ? topic : 1,
          TransportThreadId: recovered ? topic : 1,
          InboundEventKind: ambient ? "room_event" : "user_request",
        });
        const history = JSON.stringify(observed.ChannelStructuredContext);
        expect(history ?? "").not.toContain("Other account secret");
        if (ambient) {
          expect(observed.InboundHistory).toBeUndefined();
          expect(observed.ChannelStructuredContext).toBeUndefined();
        } else {
          expect(observed.media).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "image",
                path: "/tmp/replied-photo.jpg",
              }),
            ]),
          );
          if (historyLimit === 0) {
            expect(observed.ChannelStructuredContext).toMatchObject([
              {
                type: "chat_window",
                payload: {
                  messages: [{ message_id: "90", is_reply_target: true, media_type: "image" }],
                },
              },
            ]);
            expect(observed.ChannelStructuredContext?.[0]).not.toHaveProperty(
              "sessionTranscriptDedupeMessageIds",
            );
          }
          if (recovered && topic === 3731 && historyLimit > 0) {
            expect(observed.InboundHistory).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ body: "After watermark", timestamp: (now - 2) * 1000 }),
              ]),
            );
            expect(history).not.toContain("Before self");
            expect(history).not.toContain("Self marker");
          } else if (recovered) {
            expect(history ?? "").not.toContain("General context");
            expect(history ?? "").not.toContain("After watermark");
          }
        }
        expect(
          await cache.get({
            accountId,
            chatId: forumChat.id,
            messageId: String(currentMessage.message_id),
          }),
        ).toMatchObject({
          threadId: "1",
          body: currentText,
        });
        const sends = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
        expect(sends).toHaveLength(ambient ? 0 : 1);
        if (!ambient) {
          expect(sends[0]?.[1]).toMatchObject({
            chat_id: String(forumChat.id),
            text: "Test response",
          });
          if (recovered) {
            expect(sends[0]?.[1]).toMatchObject({ message_thread_id: topic });
            expect(getSessionEntry({ storePath, sessionKey })?.delivery).toMatchObject({
              kind: "external",
              context: {
                channel: "telegram",
                accountId,
                to: `telegram:${forumChat.id}:topic:${topic}`,
                threadId: topic,
              },
            });
          } else {
            expect(sends[0]?.[1]).not.toHaveProperty("message_thread_id");
          }
        }
      } finally {
        unregisterSessionBindingAdapter({ channel: "telegram", accountId, adapter });
      }
    },
  );
});
