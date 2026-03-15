import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import {
  extractMentionTargets,
  extractMessageBody,
  isLikelyBotMention,
  isMentionForwardRequest,
} from "./mention.js";

// 构造一个最小 FeishuMessageEvent 用于测试
function makeEvent(overrides: {
  mentions?: FeishuMessageEvent["message"]["mentions"];
  chat_type?: "p2p" | "group" | "private";
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: "sender-id" },
      sender_type: "user",
    },
    message: {
      message_id: "msg-1",
      chat_id: "chat-1",
      chat_type: overrides.chat_type ?? "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: overrides.mentions ?? [],
    },
  } as FeishuMessageEvent;
}

const BOT_OPEN_ID = "ou-bot-self";
const TENANT = "tenant-abc";

// 机器人提及（空 tenant_key）
function botMention(openId: string, name: string, key: string) {
  return { key, id: { open_id: openId }, name, tenant_key: "" };
}

// 真实用户提及（非空 tenant_key）
function userMention(openId: string, name: string, key: string) {
  return { key, id: { open_id: openId }, name, tenant_key: TENANT };
}

describe("isLikelyBotMention", () => {
  it("空 tenant_key 视为机器人", () => {
    expect(isLikelyBotMention({ tenant_key: "" })).toBe(true);
  });

  it("缺少 tenant_key 视为机器人", () => {
    expect(isLikelyBotMention({})).toBe(true);
  });

  it("非空 tenant_key 视为真实用户", () => {
    expect(isLikelyBotMention({ tenant_key: "t-123" })).toBe(false);
  });
});

describe("extractMentionTargets", () => {
  it("过滤掉 bot 自身和其他机器人提及", () => {
    const event = makeEvent({
      mentions: [
        botMention(BOT_OPEN_ID, "Self", "@_user_1"),
        botMention("ou-other-bot", "OtherBot", "@_user_2"),
        userMention("ou-user1", "Alice", "@_user_3"),
      ],
    });
    const targets = extractMentionTargets(event, BOT_OPEN_ID);
    expect(targets).toEqual([{ openId: "ou-user1", name: "Alice", key: "@_user_3" }]);
  });

  it("多机器人 @bot_A @bot_B 场景 → 无提及目标", () => {
    const event = makeEvent({
      mentions: [
        botMention(BOT_OPEN_ID, "BotA", "@_user_1"),
        botMention("ou-bot-b", "BotB", "@_user_2"),
      ],
    });
    const targets = extractMentionTargets(event, BOT_OPEN_ID);
    expect(targets).toEqual([]);
  });

  it("只有真实用户提及时全部返回", () => {
    const event = makeEvent({
      mentions: [
        botMention(BOT_OPEN_ID, "Bot", "@_user_1"),
        userMention("ou-user1", "Alice", "@_user_2"),
        userMention("ou-user2", "Bob", "@_user_3"),
      ],
    });
    const targets = extractMentionTargets(event, BOT_OPEN_ID);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.name)).toEqual(["Alice", "Bob"]);
  });

  it("无 botOpenId 时仍过滤机器人提及", () => {
    const event = makeEvent({
      mentions: [
        botMention("ou-some-bot", "SomeBot", "@_user_1"),
        userMention("ou-user1", "Alice", "@_user_2"),
      ],
    });
    const targets = extractMentionTargets(event);
    expect(targets).toEqual([{ openId: "ou-user1", name: "Alice", key: "@_user_2" }]);
  });
});

describe("isMentionForwardRequest", () => {
  describe("群聊", () => {
    it("@bot_A @bot_B → 不是转发请求（无真实用户）", () => {
      const event = makeEvent({
        chat_type: "group",
        mentions: [
          botMention(BOT_OPEN_ID, "BotA", "@_user_1"),
          botMention("ou-bot-b", "BotB", "@_user_2"),
        ],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(false);
    });

    it("@bot @user → 是转发请求", () => {
      const event = makeEvent({
        chat_type: "group",
        mentions: [
          botMention(BOT_OPEN_ID, "Bot", "@_user_1"),
          userMention("ou-user1", "Alice", "@_user_2"),
        ],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(true);
    });

    it("只有 @bot → 不是转发请求", () => {
      const event = makeEvent({
        chat_type: "group",
        mentions: [botMention(BOT_OPEN_ID, "Bot", "@_user_1")],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(false);
    });

    it("@bot @bot_B @user → 是转发请求（有真实用户）", () => {
      const event = makeEvent({
        chat_type: "group",
        mentions: [
          botMention(BOT_OPEN_ID, "BotA", "@_user_1"),
          botMention("ou-bot-b", "BotB", "@_user_2"),
          userMention("ou-user1", "Alice", "@_user_3"),
        ],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(true);
    });

    it("无提及 → 不是转发请求", () => {
      const event = makeEvent({ chat_type: "group", mentions: [] });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(false);
    });
  });

  describe("私聊", () => {
    it("私聊中 @user → 是转发请求", () => {
      const event = makeEvent({
        chat_type: "p2p",
        mentions: [userMention("ou-user1", "Alice", "@_user_1")],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(true);
    });

    it("私聊中只 @另一个机器人 → 不是转发请求", () => {
      const event = makeEvent({
        chat_type: "p2p",
        mentions: [botMention("ou-other-bot", "OtherBot", "@_user_1")],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(false);
    });

    it("私聊中 @bot_B @user → 是转发请求（有真实用户）", () => {
      const event = makeEvent({
        chat_type: "p2p",
        mentions: [
          botMention("ou-bot-b", "BotB", "@_user_1"),
          userMention("ou-user1", "Alice", "@_user_2"),
        ],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(true);
    });

    it("'private' chat_type 行为与 p2p 一致", () => {
      const event = makeEvent({
        chat_type: "private",
        mentions: [userMention("ou-user1", "Alice", "@_user_1")],
      });
      expect(isMentionForwardRequest(event, BOT_OPEN_ID)).toBe(true);
    });
  });
});

describe("extractMessageBody", () => {
  it("移除 @ 占位符并整理空白", () => {
    const result = extractMessageBody("@_user_1 @_user_2 hello world", ["@_user_1", "@_user_2"]);
    expect(result).toBe("hello world");
  });
});
