// Telegram tests cover bot-pair loop protection for channel posts through the real channel_post handler.
import { beforeEach, describe, expect, it } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";

const {
  dispatchReplyWithBufferedBlockDispatcher,
  getLoadConfigMock,
  getOnHandler,
  telegramBotDepsForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

type ChannelPostHandler = (ctx: Record<string, unknown>) => Promise<void>;

// The pair guard is process-wide, so each case posts in its own channel.
const CASES = [
  ["a human admin's channel post carrying sender_chat", -1005550101, true],
  ["a human admin's channel post without sender_chat", -1005550102, false],
] as const;

const PEER_BOT = { id: 5151, is_bot: true, first_name: "Peer", username: "peer_bot" } as const;

function channelPost(
  channelId: number,
  withSenderChat: boolean,
  messageId: number,
  from?: typeof PEER_BOT,
) {
  const channel = { id: channelId, type: "channel", title: "Loop Channel" } as const;
  return {
    update: { update_id: 7000 + messageId },
    // Without `from`, nothing identifies a bot as the post's author. The handler stamps the
    // channel as a synthetic `is_bot` sender, which must not count.
    channelPost: {
      chat: channel,
      ...(withSenderChat ? { sender_chat: channel } : {}),
      ...(from ? { from } : {}),
      message_id: messageId,
      date: 1_736_380_800 + messageId,
      text: `post ${messageId}`,
    },
    me: telegramBotInfoForTest,
    getFile: async () => ({}),
  };
}

function channelPostHandler(channelId: number): ChannelPostHandler {
  getLoadConfigMock().mockReturnValue({
    channels: {
      defaults: {
        botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
      },
      telegram: {
        groupPolicy: "open",
        groups: { [String(channelId)]: { enabled: true, requireMention: false } },
      },
    },
  });
  createTelegramBotCore({
    token: "tok",
    botInfo: telegramBotInfoForTest,
    telegramDeps: telegramBotDepsForTest,
  });
  return getOnHandler("channel_post") as ChannelPostHandler;
}

describe("createTelegramBot channel_post bot-loop protection", () => {
  beforeEach(() => {
    setTelegramPluginStateRuntimeForTests();
  });

  it.each(CASES)(
    "never budgets %s, whose only sender is the channel itself",
    async (_label, channelId, withSenderChat) => {
      const handler = channelPostHandler(channelId);

      const dispatchCallsAfterEachPost: number[] = [];
      for (const messageId of [1, 2, 3]) {
        await handler(channelPost(channelId, withSenderChat, messageId));
        dispatchCallsAfterEachPost.push(dispatchReplyWithBufferedBlockDispatcher.mock.calls.length);
      }

      expect(dispatchCallsAfterEachPost).toEqual([1, 2, 3]);
    },
  );

  it("still budgets a channel post whose `from` names another bot", async () => {
    const channelId = -1005550103;
    const handler = channelPostHandler(channelId);

    const dispatchCallsAfterEachPost: number[] = [];
    for (const messageId of [1, 2, 3]) {
      await handler(channelPost(channelId, true, messageId, PEER_BOT));
      dispatchCallsAfterEachPost.push(dispatchReplyWithBufferedBlockDispatcher.mock.calls.length);
    }

    expect(dispatchCallsAfterEachPost).toEqual([1, 2, 2]);
  });
});
