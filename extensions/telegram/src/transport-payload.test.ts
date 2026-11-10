import assert from "node:assert/strict";
import type { Message } from "grammy/types";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import { telegramPlugin } from "./channel.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import { sendTypingTelegram } from "./send-actions.js";
import { sendMessageTelegram } from "./send-message.js";
import { sendPollTelegram } from "./send-special.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "./send.telegram-http.test-support.js";

const DIRECT_CHAT_ID = -100321;
const DIRECT_TOPIC_ID = 77;
const DIRECT_TARGET = `${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`;
const DIRECT_THREAD = { id: DIRECT_TOPIC_ID, scope: "direct-messages" as const };
const USER = { id: 700, is_bot: false, first_name: "Subscriber" };
const CHAT = { id: DIRECT_CHAT_ID, type: "supergroup" };
const topic = (topic_id: number) => ({ topic_id, user: USER });
const mediaEditError = new Error("400: Bad Request: there is no text in the message to edit");

function directMessagesMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 41,
    date: 1_700_000_000,
    chat: {
      ...CHAT,
      title: "Channel Direct Messages",
      is_direct_messages: true,
    },
    direct_messages_topic: topic(DIRECT_TOPIC_ID),
    from: USER,
    text: "button",
    ...overrides,
  };
}

describe("Telegram topic transport payloads", () => {
  const fixture = useTelegramHttpFixture();
  const { requests, cfg } = fixture;
  const sendOptions = () => ({ cfg, token: cfg.channels.telegram.botToken, api: fixture.bot.api });
  const jsonFor = (method: string) => {
    const request = requests.find((candidate) => candidate.method === method);
    assert(request, `Missing ${method} request`);
    return request.fields;
  };
  function expectDirectPayload(method: string) {
    const payload = jsonFor(method);
    expect(payload).toMatchObject({ direct_messages_topic_id: DIRECT_TOPIC_ID });
    expect(payload).not.toHaveProperty("message_thread_id");
  }
  function callbackActions(overrides: Record<string, unknown> = {}) {
    return createTelegramCallbackMessageActions({
      bot: fixture.bot,
      callbackMessage: directMessagesMessage(overrides) as unknown as Message,
      threadSpec: DIRECT_THREAD,
    });
  }

  beforeEach(() => {
    fixture.responseFor = (method, fields) =>
      method.startsWith("send")
        ? directMessagesMessage({
            message_id: requests.length + 100,
            chat: { ...CHAT, is_direct_messages: fields.direct_messages_topic_id !== undefined },
            direct_messages_topic:
              fields.direct_messages_topic_id !== undefined
                ? topic(Number(fields.direct_messages_topic_id))
                : undefined,
            text: "accepted",
          })
        : true;
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearTelegramRuntime();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
  });

  it("serializes direct draft destinations while keeping edits topic-free", async () => {
    const direct = createTelegramDraftStream({
      api: fixture.bot.api,
      chatId: DIRECT_CHAT_ID,
      thread: DIRECT_THREAD,
    });
    direct.update("direct preview");
    await direct.flush();
    direct.update("direct preview updated");
    await direct.flush();
    await direct.discard?.();

    expectDirectPayload("sendMessage");
    expect(jsonFor("editMessageText")).not.toHaveProperty("message_thread_id");
    expect(jsonFor("editMessageText")).not.toHaveProperty("direct_messages_topic_id");
  });

  it("serializes a channel Direct Messages document through real multipart transport", async () => {
    await sendMessageTelegram(DIRECT_TARGET, "document", {
      ...sendOptions(),
      mediaUrl: "/tmp/direct-topic-proof.pdf",
      mediaAccess: {
        localRoots: ["/tmp"],
        readFile: async () => Buffer.from("%PDF-1.7 direct-topic-proof"),
      },
    });

    const fields = jsonFor("sendDocument");
    expect(fields.direct_messages_topic_id).toBe("77");
    expect(fields).not.toHaveProperty("message_thread_id");
    expect(resolveTelegramTestUpload(fields, "document")).toBeInstanceOf(File);
  });

  it("round-trips a persisted direct-topic conversation into the canonical Bot API field", async () => {
    const directRef = telegramPlugin.messaging?.resolveInboundConversation?.({
      to: `telegram:${DIRECT_TARGET}`,
      isGroup: true,
    });
    expect(directRef?.conversationId).toBe(DIRECT_TARGET);
    assert(directRef?.conversationId, "expected direct-topic conversation reference");
    const persistedRef = structuredClone({
      conversationId: directRef.conversationId,
      parentConversationId: directRef.parentConversationId,
    });
    const target = telegramPlugin.messaging?.resolveDeliveryTarget?.(persistedRef);
    assert(target?.to, "expected persisted direct-topic delivery target");
    setTelegramPluginStateRuntimeForTests();
    await sendMessageTelegram(target.to, "roundtrip", {
      ...sendOptions(),
      messageThreadId: target.threadId ? Number(target.threadId) : undefined,
    });

    expectDirectPayload("sendMessage");
  });

  it("serializes local rich delivery through the canonical direct topic field", async () => {
    await sendMessageTelegram(DIRECT_TARGET, "**rich**", {
      ...sendOptions(),
      cfg: { ...cfg, channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
    });

    expectDirectPayload("sendRichMessage");
  });

  it("rejects poll and typing for channel Direct Messages without transport", async () => {
    await expect(
      sendPollTelegram(
        DIRECT_TARGET,
        { question: "Choose", options: ["A", "B"], maxSelections: 1 },
        sendOptions(),
      ),
    ).rejects.toThrow(/polls are not supported in channel Direct Messages/i);
    await expect(sendTypingTelegram(DIRECT_TARGET, sendOptions())).rejects.toThrow(
      /typing is not supported in channel Direct Messages/i,
    );
    expect(requests).toHaveLength(0);
  });

  it("removes business media callbacks before sending their text replacement", async () => {
    const actions = callbackActions({
      business_connection_id: "business-media-1",
      text: undefined,
      caption: "Choose an action",
    });
    vi.spyOn(fixture.bot.api, "editMessageText").mockRejectedValueOnce(mediaEditError);
    await actions.editCallbackMessageWithButtons("Replacement", []);

    expect(requests.map((request) => request.method)).toEqual([
      "deleteBusinessMessages",
      "sendMessage",
    ]);
    expect(jsonFor("deleteBusinessMessages")).toEqual({
      business_connection_id: "business-media-1",
      message_ids: [41],
    });
    expect(jsonFor("sendMessage")).toMatchObject({
      business_connection_id: "business-media-1",
      direct_messages_topic_id: DIRECT_TOPIC_ID,
      text: "Replacement",
    });
  });
});
