import path from "node:path";
import { webhookCallback, type Bot } from "grammy";
import type { Message, Update } from "grammy/types";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  apiCalls,
  apiResponses,
  commandMessage,
  createBot,
  from,
  groupChat,
  harness,
  photo,
  publishTelegramTestConfig,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { TelegramConfigSchema } from "./config-schema.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";
import { createForumTopicTelegram } from "./send-forum-topics.js";
import { getTopicCreatorUserId } from "./topic-name-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let updateId = 12_000;
let storePath: string;
let runtimeError: MockInstance<typeof defaultRuntime.error>;

beforeEach(() => {
  storePath = path.join(tempDirs.make("telegram-bot-topic-admission-"), "sessions.json");
  resetTelegramTopicNameCacheForTest();
  runtimeError = vi.spyOn(defaultRuntime, "error");
});
afterEach(() => {
  resetTelegramTopicNameCacheForTest();
  runtimeError.mockRestore();
});

function config(group: TelegramGroupConfig): OpenClawConfig {
  const telegram = {
    dmPolicy: "open" as const,
    allowFrom: ["*"],
    groupPolicy: "open" as const,
    autoTopicLabel: false,
    streaming: { mode: "off" as const },
    groups: { "*": group },
  };
  TelegramConfigSchema.parse(telegram);
  return { session: { store: storePath }, commands: { native: false }, channels: { telegram } };
}

function topicMessage(text: string, threadId = 99) {
  return {
    ...commandMessage(text),
    chat: groupChat,
    message_thread_id: threadId,
    is_topic_message: true,
    entities: [],
  };
}

async function receive(bot: Bot, message: NonNullable<Update["message"]>) {
  const response = await webhookCallback(
    bot,
    "std/http",
  )(
    new Request("http://localhost/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: ++updateId, message }),
    }),
  );
  expect(response.status).toBe(200);
  expect(runtimeError).not.toHaveBeenCalled();
}

async function createTopic(cfg: OpenClawConfig, creatorToken?: string) {
  apiResponses.set("createForumTopic", {
    ok: true,
    result: { message_thread_id: 99, name: "Bot topic", icon_color: 7322096 },
  });
  await createForumTopicTelegram(String(groupChat.id), "Bot topic", {
    cfg,
    ...(creatorToken ? { token: creatorToken } : {}),
  });
  await expect(
    getTopicCreatorUserId(
      groupChat.id,
      99,
      resolveStorePath(cfg.session?.store, { agentId: "main" }),
    ),
  ).resolves.toBe(creatorToken ? 123456789 : telegramBotInfoForTest.id);
}

describe("Telegram bot-created topic mention policy", () => {
  it("accepts text and media in its created topic after reopen while keeping parent and sender gates", async () => {
    const cfg = config({
      requireMention: true,
      requireMentionInBotThreads: false,
      allowFrom: [String(from.id)],
    });
    publishTelegramTestConfig(cfg);
    await createTopic(cfg);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    const bot = await createBot(false, true, cfg);

    await receive(bot, topicMessage("unmentioned parent", 1));
    await receive(bot, { ...topicMessage("denied sender"), from: { ...from, id: 123 } });
    expect(harness.replySpy).not.toHaveBeenCalled();

    await receive(bot, topicMessage("unmentioned follow-up"));
    await receive(bot, { ...topicMessage(""), text: undefined, photo });
    expect(harness.replySpy).toHaveBeenCalledTimes(2);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      TopicName: "Bot topic",
      SessionKey: "agent:main:telegram:group:-10042001:topic:99",
    });
    expect(apiCalls).toHaveBeenCalledWith("getFile", expect.anything());
  });

  it.each([
    { name: "omitted", setting: undefined, topic: undefined, otherBot: false, admitted: false },
    { name: "another bot", setting: false, topic: undefined, otherBot: true, admitted: false },
    { name: "topic override", setting: true, topic: false, otherBot: false, admitted: true },
  ])(
    "keeps exact ownership and configured precedence: $name",
    async ({ setting, topic, otherBot, admitted }) => {
      const cfg = config({
        requireMention: true,
        requireMentionInBotThreads: setting,
        topics: { "99": { requireMentionInBotThreads: topic } },
      });
      const bot = await createBot(false, true, cfg);
      await createTopic(cfg, otherBot ? "123456789:another-test-bot" : undefined);
      await receive(bot, topicMessage("ordinary follow-up"));
      expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  it("requires mentions for text and media replies while preserving authorized text commands", async () => {
    const cfg = config({ requireMention: false, requireMentionInBotThreads: true });
    const bot = await createBot(false, true, cfg);
    await receive(bot, {
      ...topicMessage(""),
      text: undefined,
      photo,
      reply_to_message: {
        message_id: 99,
        date: 1736380700,
        chat: groupChat,
        from: telegramBotInfoForTest,
        forum_topic_created: { name: "Bot topic", icon_color: 7322096 },
        reply_to_message: undefined,
      } satisfies NonNullable<Message["reply_to_message"]>,
    });
    const reply = {
      ...topicMessage("Earlier bot answer"),
      from: telegramBotInfoForTest,
      reply_to_message: undefined,
    } satisfies NonNullable<Message["reply_to_message"]>;
    await receive(bot, { ...topicMessage("follow-up"), reply_to_message: reply });
    await receive(bot, { ...topicMessage(""), text: undefined, photo, reply_to_message: reply });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls).not.toHaveBeenCalledWith("getFile", expect.anything());

    await receive(bot, {
      ...topicMessage("@openclaw_bot follow-up"),
      entities: [{ type: "mention", offset: 0, length: 13 }],
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    await receive(bot, {
      ...topicMessage("/status"),
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(harness.replySpy.mock.calls[1]?.[0]).toMatchObject({
      CommandBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandTurn: { kind: "text-slash", source: "text", body: "/status", authorized: true },
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      MessageThreadId: 99,
    });
  });

  it.each(["creation", "editing", "foreign topic"] as const)(
    "uses observed creation identity without inferring ownership from %s",
    async (source) => {
      const cfg = config({ requireMention: true, requireMentionInBotThreads: false });
      const bot = await createBot(false, true, cfg);
      const topicService = {
        message_id: source === "foreign topic" ? 100 : 99,
        date: 1736380700,
        chat: groupChat,
        from: telegramBotInfoForTest,
        reply_to_message: undefined,
        ...(source === "editing"
          ? { forum_topic_edited: { name: "Renamed" } }
          : { forum_topic_created: { name: "Created", icon_color: 7322096 } }),
      } satisfies NonNullable<Message["reply_to_message"]>;
      await receive(bot, {
        ...topicMessage(""),
        text: undefined,
        photo,
        reply_to_message: topicService,
      });
      expect(harness.replySpy).toHaveBeenCalledTimes(source === "creation" ? 1 : 0);
    },
  );
});
