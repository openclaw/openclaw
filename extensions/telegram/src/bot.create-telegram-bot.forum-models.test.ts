// Focused regression test for /models callback handling in Telegram forum topics.
// This file can be merged into bot.create-telegram-bot.test.ts once the bug is fixed.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOnHandler, telegramBotDepsForTest } from "./bot.create-telegram-bot.test-harness.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const pluginStateTestRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
const configMutation = await import("openclaw/plugin-sdk/config-mutation");
const {
  editMessageTextSpy,
  getChatSpy,
  middlewareUseSpy,
  onSpy,
  sequentializeSpy,
  telegramBotRuntimeForTest,
  answerCallbackQuerySpy,
} = harness;
const { createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot-core.js");
const { resetTelegramForumFlagCacheForTest } = await import("./bot/helpers.js");

let createTelegramBot: (
  opts: Omit<Parameters<typeof createTelegramBotBase>[0], "telegramDeps">,
) => ReturnType<typeof createTelegramBotBase>;

const FORUM_CHAT_ID = -1009999999999;
const TOPIC_ID = 28;
const SENDER_ID = 123456789;

function makeForumCallbackCtx(params: {
  data: string;
  messageThreadId?: number;
  isTopicMessage?: boolean;
}) {
  return {
    update: { update_id: 1001 },
    callbackQuery: {
      id: "cbq-forum-models-1",
      data: params.data,
      from: { id: SENDER_ID, first_name: "Test", username: "testuser" },
      message: {
        chat: {
          id: FORUM_CHAT_ID,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 1, is_bot: true, username: "openclaw_bot" },
        date: 1736380800,
        message_id: 1261,
        ...(params.messageThreadId === undefined
          ? {}
          : { message_thread_id: params.messageThreadId }),
        is_topic_message: params.isTopicMessage ?? true,
        text: "Select a provider:",
      },
    },
    me: { username: "openclaw_bot", has_topics_enabled: true },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

async function runMiddlewareChainForCallback(ctx: Record<string, unknown>) {
  const callbackHandler = getOnHandler("callback_query");
  const middlewares = middlewareUseSpy.mock.calls
    .map((call) => call[0])
    .filter(
      (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
        typeof fn === "function",
    );
  let idx = -1;
  const dispatch = async (i: number): Promise<void> => {
    if (i <= idx) {
      throw new Error("middleware dispatch called multiple times");
    }
    idx = i;
    const fn = middlewares[i];
    if (!fn) {
      await callbackHandler(ctx);
      return;
    }
    await fn(ctx, async () => dispatch(i + 1));
  };
  await dispatch(0);
}

function mockTelegramConfigWrites() {
  return vi.spyOn(configMutation, "mutateConfigFile").mockResolvedValue({} as never);
}

const FORUM_OPEN_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: "openai/gpt-5.4",
    },
  },
  channels: {
    telegram: {
      dmPolicy: "open",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      groups: {
        [String(FORUM_CHAT_ID)]: {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
};

describe("createTelegramBot /models in forum topic", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    delete process.env.TZ;
  });
  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
    sequentializeSpy.mockImplementation(() => async (_ctx: unknown, next?: () => Promise<void>) => {
      if (typeof next === "function") {
        await next();
      }
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    pluginStateTestRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
    onSpy.mockReset();
    middlewareUseSpy.mockReset();
    editMessageTextSpy.mockReset();
    editMessageTextSpy.mockResolvedValue({ message_id: 88 });
    answerCallbackQuerySpy.mockReset();
    answerCallbackQuerySpy.mockResolvedValue(undefined);
    getChatSpy.mockReset();
    getChatSpy.mockResolvedValue({ id: FORUM_CHAT_ID, is_forum: true, type: "supergroup" });
    (telegramBotDepsForTest.getRuntimeConfig as ReturnType<typeof vi.fn>).mockReturnValue(
      FORUM_OPEN_CONFIG,
    );
  });

  it("renders model list when a provider button is clicked in a forum topic", async () => {
    const cleanup = mockTelegramConfigWrites();
    try {
      createTelegramBot({ token: "tok" });
      const ctx = makeForumCallbackCtx({
        data: "mdl_list_openai_1",
        messageThreadId: TOPIC_ID,
        isTopicMessage: true,
      });

      await runMiddlewareChainForCallback(ctx);

      expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      const call = editMessageTextSpy.mock.calls[0];
      const text = call?.[2];
      const params = call?.[3];
      expect(typeof text === "string" ? text : "").toContain("openai");
      expect(params).toMatchObject({
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                callback_data: expect.stringMatching(/^mdl_sel_openai\/gpt-5\.4$/),
              }),
            ]),
          ]),
        },
      });
    } finally {
      cleanup.mockRestore();
    }
  });

  it("preserves topic session key for /models callbacks in a forum topic", async () => {
    const cleanup = mockTelegramConfigWrites();
    try {
      createTelegramBot({ token: "tok" });
      const ctx = makeForumCallbackCtx({
        data: "mdl_sel_openai/gpt-5.4",
        messageThreadId: TOPIC_ID,
        isTopicMessage: true,
      });

      await runMiddlewareChainForCallback(ctx);

      expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      const finalText = editMessageTextSpy.mock.calls[0]?.[2];
      expect(typeof finalText === "string" ? finalText : "").toContain("reset to default");
    } finally {
      cleanup.mockRestore();
    }
  });
});
