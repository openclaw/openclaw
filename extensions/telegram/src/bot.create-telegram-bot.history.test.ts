import {
  closeOpenClawStateDatabaseForTest,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

// The harness installs vi.doMock runtime overrides before the bot module is loaded.
const { getLoadConfigMock, getOnHandler, replySpy, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const loadConfig = getLoadConfigMock();
const baseCtx = {
  me: { id: 999, username: "openclaw_bot" },
  getFile: async () => ({ download: async () => new Uint8Array() }),
};
let telegramTestState: OpenClawTestState;

describe("createTelegramBot group history", () => {
  beforeAll(async () => {
    closeOpenClawStateDatabaseForTest();
    telegramTestState = await createOpenClawTestState({
      label: "telegram-bot-history",
      layout: "state-only",
    });
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await telegramTestState.cleanup();
  });

  it.each(["sender_chat", "chat"] as const)(
    "retains channel posts without a %s username after reopen",
    async (senderSource) => {
      const chat = { id: -100777111222, type: "channel", title: "Private Channel" } as const;
      loadConfig.mockReturnValue({
        messages: { inbound: { debounceMs: 0 } },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { [chat.id]: { enabled: true, requireMention: true } },
          },
        },
      });
      setTelegramPluginStateRuntimeForTests();
      createTelegramBotCore({
        token: "tok",
        botInfo: telegramBotInfoForTest,
        telegramDeps: { ...telegramBotDepsForTest },
      });
      await getOnHandler("channel_post")({
        ...baseCtx,
        channelPost: {
          chat,
          ...(senderSource === "sender_chat" ? { sender_chat: chat } : {}),
          message_id: 601,
          date: 1736380800,
          text: "The maintenance window starts at noon.",
        },
      });
      expect(replySpy).not.toHaveBeenCalled();

      const cfg = telegramBotDepsForTest.getRuntimeConfig();
      const scope = resolveTelegramMessageCacheScope(
        telegramBotDepsForTest.resolveStorePath(cfg.session?.store, { agentId: "main" }),
      );
      resetTelegramMessageCacheForTest();
      const history = await createTelegramMessageCache({ scope }).readHistory({
        accountId: "default",
        chatId: chat.id,
        limit: 10,
      });
      expect(history.messages).toEqual([
        expect.objectContaining({
          messageId: "601",
          sender: "Private Channel",
          senderId: String(chat.id),
          body: "The maintenance window starts at noon.",
        }),
      ]);
    },
  );

  it("keeps a bounded automatic window while retaining quiet earlier discussion after reopen", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["111", "222"],
          groups: { "*": { requireMention: true } },
        },
      },
    });
    setTelegramPluginStateRuntimeForTests();
    const chatId = -10042;
    createTelegramBotCore({
      token: "tok",
      botInfo: telegramBotInfoForTest,
      telegramDeps: { ...telegramBotDepsForTest },
    });
    const handler = getOnHandler("message");
    for (let messageId = 501; messageId <= 555; messageId++) {
      await handler({
        ...baseCtx,
        message: {
          chat: { id: chatId, type: "supergroup", title: "Ops" },
          text: messageId === 501 ? "The launch code is cobalt." : `Quiet update ${messageId}`,
          date: 1736380800 + messageId,
          message_id: messageId,
          from: { id: 111, is_bot: false, first_name: "Requester" },
        },
      });
    }
    expect(replySpy).not.toHaveBeenCalled();
    await handler({
      ...baseCtx,
      message: {
        chat: { id: chatId, type: "supergroup", title: "Ops" },
        text: "@openclaw_bot what was the launch code?",
        date: 1736381400,
        message_id: 560,
        from: { id: 222, is_bot: false, first_name: "Operator" },
        entities: [{ type: "mention", offset: 0, length: 13 }],
      },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0];
    if (!payload) {
      throw new Error("Expected reply payload");
    }
    expect(payload.InboundHistory?.map((entry) => entry.messageId)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(506 + index)),
    );
    expect(JSON.stringify(payload.ChannelStructuredContext)).not.toContain("cobalt");

    const cfg = telegramBotDepsForTest.getRuntimeConfig();
    const scope = resolveTelegramMessageCacheScope(
      telegramBotDepsForTest.resolveStorePath(cfg.session?.store, { agentId: "main" }),
    );
    resetTelegramMessageCacheForTest();
    const earlier = await createTelegramMessageCache({ scope }).readHistory({
      accountId: "default",
      chatId,
      before: "506",
      limit: 5,
    });
    expect(earlier.messages.map((message) => message.messageId)).toEqual([
      "501",
      "502",
      "503",
      "504",
      "505",
    ]);
    expect(earlier.messages[0]?.body).toBe("The launch code is cobalt.");
  });
});
