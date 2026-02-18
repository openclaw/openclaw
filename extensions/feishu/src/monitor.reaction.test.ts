import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import type { FeishuMessageInfo } from "./send.js";

/**
 * Tests for reaction event handling in monitor.ts.
 *
 * Since registerEventHandlers is not exported, we test the reaction handling
 * logic by extracting and verifying the behavior inline: filtering rules,
 * synthetic event construction, and dispatch.
 */

// Mock handleFeishuMessage to capture calls
const mockHandleFeishuMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("./bot.js", () => ({
  handleFeishuMessage: (...args: unknown[]) => mockHandleFeishuMessage(...args),
}));

/**
 * Simulate the reaction event filtering and synthetic message construction
 * extracted from monitor.ts registerEventHandlers.
 *
 * The `getReactedMessage` callback simulates getMessageFeishu — it returns
 * the message info for the reacted message, or null if not found.
 */
function processReactionEvent(
  data: {
    message_id: string;
    reaction_type: { emoji_type: string };
    operator_type: string;
    user_id: { open_id: string };
    action_time?: string;
  },
  botOpenId: string | undefined,
  getReactedMessage?: (messageId: string) => FeishuMessageInfo | null,
): FeishuMessageEvent | null {
  const emoji = data.reaction_type?.emoji_type;
  const messageId = data.message_id;
  const senderId = data.user_id?.open_id;

  // Skip bot self-reactions
  if (data.operator_type === "app" || senderId === botOpenId) {
    return null;
  }

  // Skip typing indicator emoji
  if (emoji === "Typing") {
    return null;
  }

  // Only process reactions on messages sent by this bot
  if (botOpenId && getReactedMessage) {
    const reactedMsg = getReactedMessage(messageId);
    const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
    if (!reactedMsg || !isBotMessage) {
      return null;
    }
  }

  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:test-uuid`,
      chat_id: `p2p:${senderId}`,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({
        text: `[reacted with ${emoji} to message ${messageId}]`,
      }),
    },
  };
}

/** Helper to create a mock FeishuMessageInfo */
function mockMessageInfo(overrides: Partial<FeishuMessageInfo> = {}): FeishuMessageInfo {
  return {
    messageId: "om_msg1",
    chatId: "oc_chat1",
    content: "hello",
    contentType: "text",
    ...overrides,
  };
}

describe("reaction event handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("filtering", () => {
    it("filters out reactions from apps (operator_type === 'app')", () => {
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "app",
          user_id: { open_id: "ou_user1" },
        },
        "ou_bot123",
      );
      expect(result).toBeNull();
    });

    it("filters out reactions from the bot itself by open_id", () => {
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_bot123" },
        },
        "ou_bot123",
      );
      expect(result).toBeNull();
    });

    it("filters out Typing indicator emoji", () => {
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "Typing" },
          operator_type: "user",
          user_id: { open_id: "ou_user1" },
        },
        "ou_bot123",
      );
      expect(result).toBeNull();
    });

    it("allows reactions on bot messages (senderType=app)", () => {
      const getBotMsg = () => mockMessageInfo({ senderType: "app" });
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_user1" },
        },
        "ou_bot123",
        getBotMsg,
      );
      expect(result).not.toBeNull();
    });

    it("filters out reactions on non-bot messages", () => {
      const getNonBotMsg = () => mockMessageInfo({ senderOpenId: "ou_other_user" });
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_user1" },
        },
        "ou_bot123",
        getNonBotMsg,
      );
      expect(result).toBeNull();
    });

    it("filters out reactions when reacted message is not found", () => {
      const getNull = () => null;
      const result = processReactionEvent(
        {
          message_id: "om_deleted",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_user1" },
        },
        "ou_bot123",
        getNull,
      );
      expect(result).toBeNull();
    });

    it("allows reactions when bot open_id is undefined (skip sender check)", () => {
      const result = processReactionEvent(
        {
          message_id: "om_msg1",
          reaction_type: { emoji_type: "HEART" },
          operator_type: "user",
          user_id: { open_id: "ou_user1" },
        },
        undefined,
      );
      expect(result).not.toBeNull();
    });
  });

  describe("synthetic event construction", () => {
    it("creates a valid FeishuMessageEvent with correct structure", () => {
      const result = processReactionEvent(
        {
          message_id: "om_original",
          reaction_type: { emoji_type: "FINGERHEART" },
          operator_type: "user",
          user_id: { open_id: "ou_sender" },
        },
        "ou_bot",
      );

      expect(result).toEqual({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_original:reaction:FINGERHEART:test-uuid",
          chat_id: "p2p:ou_sender",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "[reacted with FINGERHEART to message om_original]",
          }),
        },
      });
    });

    it("routes all reactions as p2p via sender open_id", () => {
      const result = processReactionEvent(
        {
          message_id: "om_group_msg",
          reaction_type: { emoji_type: "OK" },
          operator_type: "user",
          user_id: { open_id: "ou_group_member" },
        },
        "ou_bot",
      );

      expect(result?.message.chat_type).toBe("p2p");
      expect(result?.message.chat_id).toBe("p2p:ou_group_member");
    });

    it("includes emoji type and original message_id in synthetic content", () => {
      const result = processReactionEvent(
        {
          message_id: "om_target",
          reaction_type: { emoji_type: "CLAP" },
          operator_type: "user",
          user_id: { open_id: "ou_user" },
        },
        "ou_bot",
      );

      const content = JSON.parse(result!.message.content);
      expect(content.text).toBe("[reacted with CLAP to message om_target]");
    });

    it("generates unique message_id with emoji to prevent collisions", () => {
      // The actual code uses crypto.randomUUID() — here we verify the format
      // includes the emoji to differentiate reactions on the same message
      const result1 = processReactionEvent(
        {
          message_id: "om_same",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_user" },
        },
        "ou_bot",
      );

      const result2 = processReactionEvent(
        {
          message_id: "om_same",
          reaction_type: { emoji_type: "HEART" },
          operator_type: "user",
          user_id: { open_id: "ou_user" },
        },
        "ou_bot",
      );

      // Different emoji → different message_id prefix
      expect(result1!.message.message_id).toContain(":reaction:THUMBSUP:");
      expect(result2!.message.message_id).toContain(":reaction:HEART:");
      expect(result1!.message.message_id).not.toBe(result2!.message.message_id);
    });
  });
});
