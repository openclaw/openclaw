import { Bot, type MiddlewareFn } from "grammy";
import type { Chat, Update } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramSequentializer } from "./sequentialize.js";

const user = { id: 42, is_bot: false, first_name: "Ada" };

const chat: Chat.SupergroupChat = {
  id: -1001,
  type: "supergroup",
  title: "Sequencing",
  is_forum: true,
};

function topicMessage(updateId: number, messageId: number, topicId: number): Update {
  return {
    update_id: updateId,
    message: {
      chat,
      from: user,
      message_id: messageId,
      message_thread_id: topicId,
      is_topic_message: true,
      date: 1,
      text: "message",
    },
  };
}

function reaction(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message_reaction: {
      chat,
      message_id: messageId,
      date: 1,
      user,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
  };
}

function createSequencedBot(handler: MiddlewareFn) {
  const bot = new Bot("123:test", { botInfo: telegramBotInfoForTest });
  bot.use(createTelegramSequentializer());
  bot.use(handler);
  return bot;
}

describe("Telegram sequential middleware", () => {
  it("reserves overlapping lanes in FIFO order without blocking other topics or deleting newer tails", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const started: number[] = [];
    const bot = createSequencedBot(async (ctx) => {
      const id = ctx.update.update_id;
      started.push(id);
      if (id === 1) {
        await firstGate.promise;
      } else if (id === 2) {
        secondStarted.resolve();
        await secondGate.promise;
      }
    });
    const first = bot.handleUpdate(topicMessage(1, 77, 9));
    const second = bot.handleUpdate(topicMessage(2, 78, 9));
    const queuedReaction = bot.handleUpdate(reaction(3, 78));
    const unrelated = bot.handleUpdate(topicMessage(4, 79, 10));
    const runs = [first, second, queuedReaction, unrelated];

    try {
      await unrelated;
      expect(started).toEqual([1, 4]);

      firstGate.resolve();
      await first;
      await secondStarted.promise;
      const third = bot.handleUpdate(topicMessage(5, 80, 9));
      const anotherTopic = bot.handleUpdate(topicMessage(6, 81, 10));
      runs.push(third, anotherTopic);
      await anotherTopic;
      expect(started).toEqual([1, 4, 2, 6]);

      secondGate.resolve();
      await Promise.all(runs);
      expect(started.slice(4).toSorted((left, right) => left - right)).toEqual([3, 5]);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.allSettled(runs);
    }
  });

  it.each(["throw", "reject"])(
    "recovers from a handler %s without releasing a different unfinished constraint",
    async (failure) => {
      const gate = createDeferred<void>();
      const error = new Error("reaction failed");
      const started: number[] = [];
      const bot = createSequencedBot((ctx) => {
        const id = ctx.update.update_id;
        started.push(id);
        if (id === 1) {
          return gate.promise;
        }
        if (id === 2) {
          if (failure === "throw") {
            throw error;
          }
          return Promise.reject(error);
        }
        return Promise.resolve();
      });
      const topic = bot.handleUpdate(topicMessage(1, 76, 9));
      const failedReaction = bot.handleUpdate(reaction(2, 77));
      const rejection = expect(failedReaction).rejects.toMatchObject({ error });
      const joined = bot.handleUpdate(topicMessage(3, 77, 9));
      const runs = [topic, failedReaction, joined];

      try {
        await rejection;
        await bot.handleUpdate(topicMessage(4, 78, 10));
        expect(started).toEqual([1, 2, 4]);

        gate.resolve();
        await Promise.all([topic, joined]);
        expect(started).toEqual([1, 2, 4, 3]);
        await bot.handleUpdate(topicMessage(5, 77, 9));
        expect(started).toEqual([1, 2, 4, 3, 5]);
      } finally {
        gate.resolve();
        await Promise.allSettled(runs);
      }
    },
  );
});
