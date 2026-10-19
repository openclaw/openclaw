import { buffer } from "node:stream/consumers";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { telegramPlugin } from "./channel.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import { sendTypingTelegram } from "./send-actions.js";
import { sendMessageTelegram } from "./send-message.js";
import { sendPollTelegram } from "./send-special.js";

type CapturedRequest = {
  body: Buffer;
  contentType: string;
  method: string;
};

const TOKEN = "123456:transport-payload-test";
const DIRECT_CHAT_ID = -100321;
const DIRECT_TOPIC_ID = 77;
const DIRECT_TARGET = `${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`;
const DIRECT_THREAD = { id: DIRECT_TOPIC_ID, scope: "direct-messages" as const };
const USER = { id: 700, is_bot: false, first_name: "Subscriber" };
const CHAT = { id: DIRECT_CHAT_ID, type: "supergroup" };
const topic = (topic_id: number) => ({ topic_id, user: USER });
const mediaEditError = new Error("400: Bad Request: there is no text in the message to edit");
const cfg = {
  channels: { telegram: { botToken: TOKEN } },
  session: { store: "/tmp/openclaw-telegram-transport-payload-test.json" },
} satisfies OpenClawConfig;

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

function parseJsonBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
}

function hasMultipartField(request: CapturedRequest, name: string, value?: string): boolean {
  const body = request.body.toString("utf8");
  const field = `name="${name}"\r\n\r\n`;
  const index = body.indexOf(field);
  if (index === -1) {
    return false;
  }
  return value === undefined || body.slice(index + field.length).startsWith(value);
}

describe("Telegram topic transport payloads", () => {
  const requests: CapturedRequest[] = [];
  let nextMessageId = 100;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? Buffer.from(rawBody)
        : rawBody
          ? await buffer(rawBody as unknown as NodeJS.ReadableStream)
          : Buffer.alloc(0);
    const method = new URL(input instanceof Request ? input.url : String(input)).pathname
      .split("/")
      .at(-1);
    const captured = {
      body,
      contentType: new Headers(init?.headers).get("content-type") ?? "",
      method: method ?? "unknown",
    };
    requests.push(captured);

    const payload = captured.contentType.startsWith("application/json")
      ? parseJsonBody(captured)
      : undefined;
    const directTopic =
      payload?.direct_messages_topic_id ??
      (hasMultipartField(captured, "direct_messages_topic_id", String(DIRECT_TOPIC_ID))
        ? DIRECT_TOPIC_ID
        : undefined);
    const result = method?.startsWith("send")
      ? {
          message_id: nextMessageId++,
          date: 1_700_000_000,
          chat: {
            ...CHAT,
            is_direct_messages: directTopic !== undefined ? true : undefined,
          },
          direct_messages_topic: directTopic !== undefined ? topic(Number(directTopic)) : undefined,
          text: "accepted",
        }
      : true;
    return Response.json({ ok: true, result });
  };
  const bot = new Bot(TOKEN, { client: { fetch: asTelegramClientFetch(fetch) } });
  const sendOptions = { cfg, token: TOKEN, api: bot.api };
  const requestFor = (method: string) => {
    const request = requests.find((candidate) => candidate.method === method);
    if (!request) {
      throw new Error(`Missing ${method} request`);
    }
    return request;
  };
  const jsonFor = (method: string) => parseJsonBody(requestFor(method));
  function expectDirectPayload(method: string) {
    const payload = jsonFor(method);
    expect(payload).toMatchObject({ direct_messages_topic_id: DIRECT_TOPIC_ID });
    expect(payload).not.toHaveProperty("message_thread_id");
  }
  function callbackActions(overrides: Record<string, unknown> = {}) {
    return createTelegramCallbackMessageActions({
      bot,
      callbackMessage: directMessagesMessage(overrides) as unknown as Message,
      threadSpec: DIRECT_THREAD,
    });
  }

  beforeEach(() => {
    requests.length = 0;
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
      api: bot.api,
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
      ...sendOptions,
      mediaUrl: "/tmp/direct-topic-proof.pdf",
      mediaAccess: {
        localRoots: ["/tmp"],
        readFile: async () => Buffer.from("%PDF-1.7 direct-topic-proof"),
      },
    });

    const request = requestFor("sendDocument");
    expect(request.contentType).toMatch(/^multipart\/form-data; boundary=/i);
    expect(hasMultipartField(request, "direct_messages_topic_id", "77")).toBe(true);
    expect(hasMultipartField(request, "message_thread_id")).toBe(false);
    expect(hasMultipartField(request, "document")).toBe(true);
  });

  it("round-trips direct-topic conversation custody into the canonical Bot API field", async () => {
    const inbound = await buildTelegramMessageContextForTest({
      message: directMessagesMessage(),
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });
    expect(inbound?.ctxPayload.SessionKey).toContain(
      `telegram:group:${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`,
    );
    const directRef = telegramPlugin.messaging?.resolveInboundConversation?.({
      to: inbound?.ctxPayload.OriginatingTo,
      isGroup: true,
    });
    expect(directRef?.conversationId).toBe(DIRECT_TARGET);
    if (!directRef?.conversationId) {
      throw new Error("expected direct-topic conversation reference");
    }
    const persistedRef = structuredClone({
      conversationId: directRef.conversationId,
      parentConversationId: directRef.parentConversationId,
    });
    const target = telegramPlugin.messaging?.resolveDeliveryTarget?.(persistedRef);
    if (!target?.to) {
      throw new Error("expected persisted direct-topic delivery target");
    }
    setTelegramPluginStateRuntimeForTests();
    await sendMessageTelegram(target.to, "roundtrip", {
      ...sendOptions,
      messageThreadId: target.threadId ? Number(target.threadId) : undefined,
    });

    expectDirectPayload("sendMessage");
  });

  it("serializes local rich delivery through the canonical direct topic field", async () => {
    await sendMessageTelegram(DIRECT_TARGET, "**rich**", {
      ...sendOptions,
      cfg: { ...cfg, channels: { telegram: { botToken: TOKEN, richMessages: true } } },
    });

    expectDirectPayload("sendRichMessage");
  });

  it("rejects poll and typing for channel Direct Messages without transport", async () => {
    await expect(
      sendPollTelegram(
        DIRECT_TARGET,
        { question: "Choose", options: ["A", "B"], maxSelections: 1 },
        sendOptions,
      ),
    ).rejects.toThrow(/polls are not supported in channel Direct Messages/i);
    await expect(sendTypingTelegram(DIRECT_TARGET, sendOptions)).rejects.toThrow(
      /typing is not supported in channel Direct Messages/i,
    );
    expect(requests).toHaveLength(0);
  });

  it("deletes ordinary callbacks through their owning Bot API endpoint", async () => {
    await callbackActions().deleteCallbackMessage();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("deleteMessage");
    expect(jsonFor("deleteMessage")).toEqual({ chat_id: DIRECT_CHAT_ID, message_id: 41 });
  });

  it("removes business media callbacks before sending their text replacement", async () => {
    const actions = callbackActions({
      business_connection_id: "business-media-1",
      text: undefined,
      caption: "Choose an action",
    });
    vi.spyOn(bot.api, "editMessageText").mockRejectedValueOnce(mediaEditError);
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
