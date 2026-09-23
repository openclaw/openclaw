import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionEntry,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createStorePath = () => path.join(tempDirs.make("telegram-watermark-"), "sessions.json");
const sender = { id: 1234, is_bot: false, first_name: "Pat" };
const groupChat = { id: -1001234567890, type: "supergroup", title: "Room" } as const;

function message(
  messageId: number,
  text: string,
  extra: Partial<Pick<Message, "chat" | "entities">> = {},
) {
  return {
    chat: { id: 1234, type: "private" as const, first_name: "Pat" },
    from: sender,
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    text,
    reply_to_message: undefined,
    ...extra,
  };
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

function createRuntime(telegramCfg: TelegramAccountConfig) {
  const cfg: OpenClawConfig = { channels: { telegram: telegramCfg } };
  const storePath = createStorePath();
  return {
    cfg,
    runtime: createTelegramMessageContextRuntime({
      cfg,
      accountId: "default",
      ownerAgentId: "main",
      opts: { botInfo: telegramBotInfoForTest },
      telegramCfg,
      telegramDeps: { resolveStorePath: () => storePath },
    }),
  };
}

const previousContext = chatWindow([{ message_id: "10", body: "Earlier DM turn" }]);
const existingSession = { readSessionUpdatedAt: () => 1_700_000_000_000 };
const ambientWatermark = {
  sessionId: "session-current",
  messageId: "11",
  timestampMs: 1_700_000_001_000,
  updatedAt: 1_700_000_003_000,
};
const ambientRows = [
  { message_id: "10", body: "persisted ambient one", timestamp_ms: 1_700_000_000_000 },
  { message_id: "11", body: "persisted ambient two", timestamp_ms: 1_700_000_001_000 },
] as const;

describe("buildTelegramMessageContext prompt context", () => {
  it.each([
    { name: "existing plain DM", existing: true, reply: false, include: false },
    { name: "fresh DM", existing: false, reply: false, include: true },
    { name: "existing DM reply", existing: true, reply: true, include: true },
  ])("selects cached context for $name", async ({ existing, reply, include }) => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        ...message(12, "continue"),
        ...(reply ? { reply_to_message: message(10, "older target") } : {}),
      },
      promptContext: previousContext,
      ...(existing ? { sessionRuntime: existingSession } : {}),
    });
    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual(include ? previousContext : undefined);
  });

  it("honors per-turn zero DM history while preserving the current reply target", async () => {
    const { runtime } = createRuntime({ dmPolicy: "open", dmHistoryLimit: 10 });
    await runtime.recordMessageForReplyChain(message(10, "older unrelated DM"));
    const current = {
      ...message(12, "answer this reply target"),
      reply_to_message: message(11, "current reply target"),
    };
    await runtime.recordMessageForReplyChain(current);
    const telegramCfg: TelegramAccountConfig = { dmPolicy: "open", dmHistoryLimit: 0 };
    const context = await runtime.buildPromptContextForMessage(
      { message: current, getFile: async () => ({ file_id: "unused", file_unique_id: "unused" }) },
      current,
      await runtime.buildReplyChainForMessage(current),
      { channels: { telegram: telegramCfg } },
      telegramCfg,
    );
    expect(context).toMatchObject([
      {
        payload: {
          messages: [
            {
              message_id: "11",
              body: "current reply target",
              is_reply_target: true,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(context)).not.toContain("older unrelated DM");
  });

  it("bounds cached DM context with the per-sender override", async () => {
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
  });

  it("disables persisted DM transcript injection when the effective limit is zero", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        ...message(12, "answer this reply"),
        reply_to_message: message(10, "explicit reply target"),
      },
      dmHistoryLimit: 0,
    });
    expect(ctx?.ctxPayload.SessionTranscriptContext).toBeUndefined();
    expect(ctx?.ctxPayload.ReplyToBody).toBe("explicit reply target");
  });

  it("bounds persisted DM transcript injection with a nonzero override", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: message(12, "continue"),
      dmHistoryLimit: 2,
    });
    expect(ctx?.ctxPayload.SessionTranscriptContext).toEqual(
      expect.objectContaining({ historyLimit: 2 }),
    );
  });

  it("keeps an explicit reply target while omitting cached context before the latest bot reply", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: message(12, "@bot recover", {
        chat: groupChat,
        entities: [{ type: "mention", offset: 0, length: 4 }],
      }),
      historyLimit: 10,
      promptContext: chatWindow([
        { message_id: "10", body: "failed turn already in the transcript" },
        { message_id: "11", sender: "OpenClaw (you)", body: "LLM request failed." },
        {
          message_id: "9",
          sender: "OpenClaw (you)",
          body: "explicit reply target",
          is_reply_target: true,
        },
      ]),
    });
    expect(ctx?.ctxPayload.ChannelStructuredContext).toMatchObject([
      {
        payload: {
          messages: [
            {
              message_id: "9",
              body: "explicit reply target",
              is_reply_target: true,
            },
          ],
        },
      },
    ]);
  });

  it("applies the ambient watermark before truncating the history window", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: message(13, "@bot what happened?", {
        chat: groupChat,
        entities: [{ type: "mention", offset: 0, length: 4 }],
      }),
      historyLimit: 1,
      promptContext: chatWindow([
        { message_id: "12", body: "unpersisted gap", timestamp_ms: 1_700_000_002_000 },
        ambientRows[1],
      ]),
      sessionRuntime: { readAmbientTranscriptWatermark: () => ambientWatermark },
    });
    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "12", body: "unpersisted gap" }),
    ]);
  });

  it("omits transcript-owned ambient rows from steady-state room-event prompt text", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: message(12, "current ambient", { chat: groupChat }),
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      },
      historyLimit: 10,
      promptContext: chatWindow(ambientRows),
      sessionRuntime: {
        readAmbientTranscriptWatermark: ({ key }) =>
          key === '["telegram","default","-1001234567890",""]' ? ambientWatermark : undefined,
      },
    });
    expect(ctx?.ctxPayload).toMatchObject({
      BodyForAgent: "current ambient",
      InboundEventKind: "room_event",
      MessageSid: "12",
      SenderName: "Pat",
    });
    expect(ctx?.ctxPayload.InboundHistory).toBeUndefined();
    expect(ctx?.ctxPayload.ChannelStructuredContext).toBeUndefined();
  });

  it("backfills Telegram group history when the ambient watermark belongs to a reset session", async () => {
    const storePath = createStorePath();
    const sessionKey = "agent:main:telegram:group:-1001234567890";
    const key = resolveAmbientTranscriptWatermarkKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "before-reset", updatedAt: 1_700_000_000_000 },
    });
    await updateAmbientTranscriptWatermark({
      storePath,
      sessionKey,
      key,
      messageId: "11",
      timestampMs: 1_700_000_001_000,
    });
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath, sessionKey }),
        sessionId: "after-reset",
        updatedAt: 1_700_000_002_000,
      },
    });
    const ctx = await buildTelegramMessageContextForTest({
      message: message(13, "@bot what happened?", {
        chat: groupChat,
        entities: [{ type: "mention", offset: 0, length: 4 }],
      }),
      historyLimit: 10,
      promptContext: chatWindow([
        ...ambientRows,
        { message_id: "12", body: "unpersisted gap", timestamp_ms: 1_700_000_002_000 },
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark,
        resolveAmbientTranscriptWatermarkKey,
        resolveStorePath: () => storePath,
      },
    });
    expect(ctx?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual([
      "10",
      "11",
      "12",
    ]);
  });
});
