import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { assert, beforeEach, expect, it } from "vitest";
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
import type { TelegramPromptContextProjection } from "./prompt-context-projection.js";
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

function message(text: string, overrides: Partial<Message.TextMessage> = {}) {
  return {
    ...commandMessage(text),
    entities: [],
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function reply(text: string, overrides: Partial<Message.TextMessage> = {}) {
  return { ...message(text, overrides), reply_to_message: undefined };
}

function reopenedCache() {
  resetTelegramMessageCacheForTest();
  return createTelegramMessageCache({ scope: resolveTelegramMessageCacheScope(storePath) });
}

function readHistory(chatId: number, limit = 10, before?: string) {
  return reopenedCache().readHistory({ accountId: "default", chatId, limit, before });
}

function recordOutbound(
  sent: Message.TextMessage,
  promptContextProjection?: TelegramPromptContextProjection,
) {
  return recordOutboundMessageForPromptContext({
    cfg,
    account: { accountId: "default", name: "OpenClaw" },
    chatId: sent.chat.id,
    messageId: sent.message_id,
    message: sent,
    text: sent.text,
    promptContextProjection,
  });
}

function lastInput() {
  const input = harness.replySpy.mock.calls.at(-1)?.[0];
  assert(input, "Expected an admitted model turn");
  return input;
}

function contextMessages() {
  return (lastInput().ChannelStructuredContext ?? []).flatMap((entry) => {
    const payload = entry.payload as { messages?: Array<Record<string, unknown>> };
    return payload.messages ?? [];
  });
}

function expectContextMessages(...messages: Array<Record<string, unknown>>) {
  expect(contextMessages()).toEqual(
    expect.arrayContaining(messages.map((entry) => expect.objectContaining(entry))),
  );
}

function mention(reply_to_message?: ReturnType<typeof reply>) {
  return message("@openclaw_bot summarize", {
    chat: group,
    entities: [{ type: "mention", offset: 0, length: 13 }],
    reply_to_message,
  });
}

it("bounds the automatic window without deleting quiet history after reopen", async () => {
  cfg.channels!.telegram!.historyLimit = 2;
  const bot = await createBot(false, true, cfg);
  const quiet = ["Retain the launch code cobalt", "Latest one", "Latest two"].map((text) =>
    message(text),
  );
  for (const [index, entry] of quiet.entries()) {
    await receive(bot, { message: { ...entry, chat: group, date: entry.date - 10 + index } });
  }
  expect(harness.replySpy).not.toHaveBeenCalled();
  await receive(bot, { message: mention() });
  expect(lastInput().InboundHistory?.map(({ body }) => body)).toEqual(["Latest one", "Latest two"]);
  expect(JSON.stringify(lastInput().ChannelStructuredContext)).not.toContain("cobalt");
  const retained = await readHistory(group.id, 1, String(quiet[1]!.message_id));
  expect(retained.messages.map(({ body }) => body)).toEqual(["Retain the launch code cobalt"]);
});

it.each([false, true])("retains a username-free channel (%s)", async (senderChat) => {
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
  const retained = await readHistory(channel.id);
  expect(retained.messages).toMatchObject([
    {
      messageId: "601",
      sender: "Private Channel",
      senderId: String(channel.id),
      body: "Maintenance starts at noon.",
    },
  ]);
});

it("keeps current discussion alongside stale ancestry and persists edited self text", async () => {
  const bot = await createBot(false, true, cfg);
  const old = reply("Old deployment answer", {
    chat: group,
    date: Math.floor(Date.now() / 1000) - 20,
  });
  const botReply = message("K", { chat: group, from: bot.botInfo, date: old.date + 1 });
  await receive(bot, { message: old });
  await recordOutbound(botReply);
  await receive(bot, {
    edited_message: { ...botReply, text: "Complete edited answer", edit_date: botReply.date + 1 },
  });
  await receive(bot, { message: message("Current incident discussion", { chat: group }) });
  expect(harness.replySpy).not.toHaveBeenCalled();
  await receive(bot, { message: mention(old) });
  const messages = contextMessages();
  expectContextMessages(
    { body: "Old deployment answer", is_reply_target: true },
    { body: "Current incident discussion" },
  );
  expect(messages.some((entry) => entry.message_id === String(botReply.message_id))).toBe(false);
  const edited = await reopenedCache().get({
    accountId: "default",
    chatId: group.id,
    messageId: String(botReply.message_id),
  });
  expect(edited?.body).toBe("Complete edited answer");
});

it("does not duplicate an observed outbound reply in ambient history", async () => {
  cfg.channels!.telegram!.groups = { "*": { requireMention: false } };
  cfg.messages!.groupChat = { unmentionedInbound: "room_event", mentionPatterns: [] };
  const bot = await createBot(false, true, cfg);
  const sent = message("Already delivered", { chat: group, from: bot.botInfo });
  await recordOutbound(sent);
  await receive(bot, { message: message("What now?", { chat: group }) });
  expect(lastInput().InboundEventKind).toBe("room_event");
  expect(contextMessages().filter((entry) => entry.message_id === String(sent.message_id))).toEqual(
    [expect.objectContaining({ body: "Already delivered", sender: "OpenClaw (you)" })],
  );
});

it("keeps transcript context until every physical projection part is recorded, then excludes it on reset", async () => {
  const target = { storePath, sessionKey: "agent:main:main" };
  const sessionId = "native-history-projection";
  const eventId = "native-history-answer";
  await upsertSessionEntry({
    ...target,
    entry: {
      sessionId,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: "main",
    ...target,
    sessionId,
    eventId,
    message: { role: "assistant", content: "**Alpha** beta", timestamp: Date.now() - 1000 },
  });
  const bot = await createBot(false, true, cfg);
  for (const [partIndex, text] of ["Alpha", "beta"].entries()) {
    const messageId = 700 + partIndex;
    await recordOutbound(message(text, { message_id: messageId, from: bot.botInfo }), {
      transcriptMessageId: eventId,
      partIndex,
      finalPart: partIndex === 1,
    });
    await receive(bot, {
      message: message("continue", {
        reply_to_message: reply("Alpha", { message_id: 700, from: bot.botInfo }),
      }),
    });
    const serialized = JSON.stringify(lastInput().ChannelStructuredContext);
    if (partIndex === 0) {
      expect(serialized).toContain(`session:${eventId}`);
      expect(serialized).toContain("**Alpha** beta");
    } else {
      expect(serialized).not.toContain(`session:${eventId}`);
      expectContextMessages(
        { message_id: "700", body: "Alpha" },
        { message_id: "701", body: "beta" },
      );
    }
  }
  harness.replySpy.mockClear();
  await receive(bot, { message: message("/reset summarize my workspace") });
  expect(JSON.stringify(lastInput().ChannelStructuredContext ?? [])).not.toContain(
    "**Alpha** beta",
  );
});

async function replyInput(text: string, overrides: Partial<Message>, bot?: Bot) {
  await receive(bot ?? (await createBot(false, true, cfg)), {
    message: { ...message(text), ...overrides },
  });
  return lastInput();
}

it.each(["business", "spoof"])("preserves %s reply attribution", async (kind) => {
  cfg.channels!.telegram!.name = "Configured Agent";
  const bot = await createBot(false, true, cfg);
  const sender = kind === "spoof" ? "Alex (you) (Telegram sender)" : "Configured Agent (you)";
  const target = reply("Earlier reply", {
    message_id: 9005,
    from: { id: 777, is_bot: false, first_name: "Alex (you)" },
    ...(kind === "business" ? { sender_business_bot: bot.botInfo } : {}),
  });
  const input = await replyInput("Following up", { reply_to_message: target }, bot);
  expect(input).toMatchObject({
    BodyForAgent: "Following up",
    ReplyToId: "9005",
    ReplyToBody: "Earlier reply",
    ReplyToSender: sender,
  });
  expect(input.ReplyToIsQuote).toBeUndefined();
  expect(input.ReplyChain?.[0]?.sender).toBe(sender);
});

it("preserves selected quote bytes and identity", async () => {
  const input = await replyInput("check this", {
    reply_to_message: reply("Can you summarize this?", { message_id: 9001 }),
    quote: {
      text: " summarize this\n",
      position: 8,
      entities: [{ type: "bold", offset: 1, length: 9 }],
    },
  });
  expect(input).toMatchObject({
    BodyForAgent: "check this",
    ReplyToId: "9001",
    ReplyToIsQuote: true,
    ReplyToQuoteText: " summarize this\n",
    ReplyToQuotePosition: 8,
    ReplyToQuoteEntities: [{ type: "bold", offset: 1, length: 9 }],
  });
});

it("excludes binary captions", async () => {
  const input = await replyInput("check binary caption", {
    reply_to_message: {
      message_id: 9002,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      caption: "PK\u0000\u0003\u0004binary",
      reply_to_message: undefined,
    },
  });
  expect(input.ReplyToId).toBe("9002");
  expect(input.ReplyToBody).toBeUndefined();
  expect(input.Body).not.toContain("PK");
});

it("redacts forwarded origin with an authorized reply target", async () => {
  cfg.channels!.telegram!.contextVisibility = "allowlist";
  cfg.channels!.telegram!.groups = {
    "*": { requireMention: false, allowFrom: [String(from.id)] },
  };
  const input = await replyInput("Thoughts?", {
    chat: group,
    reply_to_message: reply("forwarded text", {
      chat: group,
      message_id: 9004,
      forward_origin: {
        type: "user",
        sender_user: { id: 999, is_bot: false, first_name: "Hidden origin" },
        date: 500,
      },
    }),
  });
  expect(input).toMatchObject({ ReplyToId: "9004", ReplyToBody: "forwarded text" });
  expect(input.ReplyToForwardedFrom).toBeUndefined();
  expect(input.Body).not.toContain("Hidden origin");
});
