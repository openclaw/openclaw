import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chat,
  commandMessage,
  createBot,
  deliverTelegramUpdate,
  from,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

const group = { id: -10042, type: "group", title: "Ops" } as const;
let updateId = 30000;
let cfg: OpenClawConfig;
let storePath: string;
beforeEach(() => {
  storePath = resolveStorePath(undefined, { agentId: "main" });
  cfg = {
    session: { store: storePath },
    messages: { inbound: { debounceMs: 0 } },
    commands: { native: false },
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        streaming: { mode: "off" },
        groups: { "*": { requireMention: true } },
      },
    },
  };
  harness.replySpy.mockResolvedValue({ text: "NO_REPLY" });
});

async function receive(bot: Bot, payload: Record<string, unknown>) {
  await deliverTelegramUpdate(bot, { update_id: ++updateId, ...payload });
}

function message(text: string) {
  return { ...commandMessage(text), entities: [], date: Math.floor(Date.now() / 1000) };
}

function lastInput() {
  const input = harness.replySpy.mock.calls.at(-1)?.[0];
  if (!input) {
    throw new Error("Expected an admitted model turn");
  }
  return input;
}

function contextMessages() {
  return (lastInput().ChannelStructuredContext ?? []).flatMap((entry) => {
    const payload = entry.payload as { messages?: Array<Record<string, unknown>> };
    return payload.messages ?? [];
  });
}

describe("registered Telegram retained history", () => {
  it("bounds the automatic window without deleting quiet history after reopen", async () => {
    cfg.channels!.telegram!.historyLimit = 2;
    const bot = await createBot(false, true, cfg);
    const quiet = ["Retain the launch code cobalt", "Latest one", "Latest two"].map(message);
    for (const [index, entry] of quiet.entries()) {
      await receive(bot, { message: { ...entry, chat: group, date: entry.date - 10 + index } });
    }
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, {
      message: {
        ...message("@openclaw_bot summarize"),
        chat: group,
        entities: [{ type: "mention", offset: 0, length: 13 }],
      },
    });
    expect(lastInput().InboundHistory?.map(({ body }) => body)).toEqual([
      "Latest one",
      "Latest two",
    ]);
    expect(JSON.stringify(lastInput().ChannelStructuredContext)).not.toContain("cobalt");
    resetTelegramMessageCacheForTest();
    const retained = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).readHistory({
      accountId: "default",
      chatId: group.id,
      before: String(quiet[1]!.message_id),
      limit: 1,
    });
    expect(retained.messages.map(({ body }) => body)).toEqual(["Retain the launch code cobalt"]);
  });

  it.each([false, true])(
    "retains channel identity without a username (sender_chat: %s)",
    async (senderChat) => {
      const channel = { id: -100777111222, type: "channel", title: "Private Channel" } as const;
      const bot = await createBot(false, true, cfg);
      await receive(bot, {
        channel_post: {
          message_id: 601,
          date: Math.floor(Date.now() / 1000),
          chat: channel,
          ...(senderChat ? { sender_chat: channel } : {}),
          text: "Maintenance starts at noon.",
        },
      });
      expect(harness.replySpy).not.toHaveBeenCalled();
      resetTelegramMessageCacheForTest();
      const retained = await createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      }).readHistory({
        accountId: "default",
        chatId: channel.id,
        limit: 10,
      });
      expect(retained.messages).toMatchObject([
        {
          messageId: "601",
          sender: "Private Channel",
          senderId: String(channel.id),
          body: "Maintenance starts at noon.",
        },
      ]);
    },
  );

  it("keeps current discussion alongside stale ancestry and persists edited self text", async () => {
    const bot = await createBot(false, true, cfg);
    const old = {
      ...message("Old deployment answer"),
      chat: group,
      date: Math.floor(Date.now() / 1000) - 20,
    };
    const botReply = { ...message("K"), chat: group, from: bot.botInfo, date: old.date + 1 };
    await receive(bot, { message: old });
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default", name: "OpenClaw" },
      chatId: group.id,
      messageId: botReply.message_id,
      message: botReply,
      text: botReply.text,
    });
    await receive(bot, {
      edited_message: { ...botReply, text: "Complete edited answer", edit_date: botReply.date + 1 },
    });
    await receive(bot, { message: { ...message("Current incident discussion"), chat: group } });
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, {
      message: {
        ...message("@openclaw_bot thoughts?"),
        chat: group,
        entities: [{ type: "mention", offset: 0, length: 13 }],
        reply_to_message: old,
      },
    });
    const messages = contextMessages();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Old deployment answer", is_reply_target: true }),
        expect.objectContaining({ body: "Current incident discussion" }),
      ]),
    );
    expect(messages.some((entry) => entry.message_id === String(botReply.message_id))).toBe(false);
    resetTelegramMessageCacheForTest();
    const edited = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: group.id, messageId: String(botReply.message_id) });
    expect(edited?.body).toBe("Complete edited answer");
  });

  it("does not duplicate an observed outbound reply in ambient history", async () => {
    cfg.channels!.telegram!.groups = { "*": { requireMention: false } };
    cfg.messages = {
      ...cfg.messages,
      groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] },
    };
    const bot = await createBot(false, true, cfg);
    const sent = { ...message("Already delivered"), chat: group, from: bot.botInfo };
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default", name: "OpenClaw" },
      chatId: group.id,
      messageId: sent.message_id,
      message: sent,
      text: sent.text,
    });
    await receive(bot, { message: { ...message("What now?"), chat: group } });
    expect(lastInput().InboundEventKind).toBe("room_event");
    expect(
      contextMessages().filter((entry) => entry.message_id === String(sent.message_id)),
    ).toEqual([expect.objectContaining({ body: "Already delivered", sender: "OpenClaw (you)" })]);
  });

  it("keeps transcript context until every physical projection part is recorded, then excludes it on reset", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "native-history-projection";
    const eventId = "native-history-answer";
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId,
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      storePath,
      sessionKey,
      sessionId,
      eventId,
      message: { role: "assistant", content: "**Alpha** beta", timestamp: Date.now() - 1000 },
    });
    const bot = await createBot(false, true, cfg);
    for (const [partIndex, text] of ["Alpha", "beta"].entries()) {
      const messageId = 700 + partIndex;
      await recordOutboundMessageForPromptContext({
        cfg,
        account: { accountId: "default", name: "OpenClaw" },
        chatId: chat.id,
        messageId,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: bot.botInfo,
          text,
        },
        text,
        promptContextProjection: {
          transcriptMessageId: eventId,
          partIndex,
          finalPart: partIndex === 1,
        },
      });
      await receive(bot, {
        message: {
          ...message("continue"),
          reply_to_message: { ...message("Alpha"), message_id: 700, from: bot.botInfo },
        },
      });
      const serialized = JSON.stringify(lastInput().ChannelStructuredContext);
      if (partIndex === 0) {
        expect(serialized).toContain(`session:${eventId}`);
        expect(serialized).toContain("**Alpha** beta");
      } else {
        expect(serialized).not.toContain(`session:${eventId}`);
        expect(contextMessages()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message_id: "700", body: "Alpha" }),
            expect.objectContaining({ message_id: "701", body: "beta" }),
          ]),
        );
      }
    }
    harness.replySpy.mockClear();
    await receive(bot, { message: message("/reset summarize my workspace") });
    expect(JSON.stringify(lastInput().ChannelStructuredContext ?? [])).not.toContain(
      "**Alpha** beta",
    );
  });

  const replyCases: Array<{
    name: string;
    message: (bot: Bot) => Record<string, unknown>;
    expected?: Record<string, unknown>;
    absent?: Array<"ReplyToBody" | "ReplyToForwardedFrom">;
    sender?: string;
    excludes?: string;
    restricted?: boolean;
  }> = [
    ...(["business", "spoof"] as const).map((kind) => ({
      name: `${kind} reply attribution`,
      message: (bot: Bot) => ({
        ...message("Following up"),
        reply_to_message: {
          ...message("Earlier reply"),
          from: { id: 777, is_bot: false, first_name: "Alex (you)" },
          ...(kind === "business" ? { sender_business_bot: bot.botInfo } : {}),
        },
      }),
      sender: kind === "spoof" ? "Alex (you) (Telegram sender)" : "Configured Agent (you)",
    })),
    {
      name: "selected quote bytes and identity",
      message: () => ({
        ...message("check this"),
        reply_to_message: { ...message("Can you summarize this?"), message_id: 9001 },
        quote: {
          text: " summarize this\n",
          position: 8,
          entities: [{ type: "bold", offset: 1, length: 9 }],
        },
      }),
      expected: {
        ReplyToId: "9001",
        ReplyToQuoteText: " summarize this\n",
        ReplyToQuotePosition: 8,
        ReplyToQuoteEntities: [{ type: "bold", offset: 1, length: 9 }],
      },
    },
    {
      name: "binary caption exclusion",
      message: () => ({
        ...message("check binary caption"),
        reply_to_message: {
          message_id: 9002,
          date: Math.floor(Date.now() / 1000),
          chat,
          from,
          caption: "PK\u0000\u0003\u0004binary",
        },
      }),
      expected: { ReplyToId: "9002" },
      absent: ["ReplyToBody"],
      excludes: "PK",
    },
    {
      name: "redacted forwarded origin with authorized reply target",
      restricted: true,
      message: () => ({
        ...message("Thoughts?"),
        chat: group,
        reply_to_message: {
          ...message("forwarded text"),
          chat: group,
          message_id: 9004,
          forward_origin: {
            type: "user",
            sender_user: { id: 999, is_bot: false, first_name: "Hidden origin" },
            date: 500,
          },
        },
      }),
      expected: { ReplyToId: "9004", ReplyToBody: "forwarded text" },
      absent: ["ReplyToForwardedFrom"],
      excludes: "Hidden origin",
    },
  ];
  it.each(replyCases)(
    "preserves $name",
    async ({ message: incoming, expected, absent, sender, excludes, restricted }) => {
      if (sender) {
        cfg.channels!.telegram!.name = "Configured Agent";
      }
      if (restricted) {
        cfg.channels!.telegram!.contextVisibility = "allowlist";
        cfg.channels!.telegram!.groups = {
          "*": { requireMention: false, allowFrom: [String(from.id)] },
        };
      }
      const bot = await createBot(false, true, cfg);
      await receive(bot, { message: incoming(bot) });
      const input = lastInput();
      if (expected) {
        expect(input).toMatchObject(expected);
      }
      for (const key of absent ?? []) {
        expect(input[key]).toBeUndefined();
      }
      if (sender) {
        expect(input.ReplyChain?.[0]?.sender).toBe(sender);
      }
      if (excludes) {
        expect(input.Body).not.toContain(excludes);
      }
    },
  );
});
