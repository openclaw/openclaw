/**
 * Tests for message parser utilities.
 */
import { describe, it, expect } from "vitest";
import { extractChatbotMessage, buildSessionKey, startsWithPrefix } from "./message-parser.js";
import {
  BASIC_CHATBOT_MESSAGE,
  DM_MESSAGE,
  JSON_STRING_DATA_MESSAGE,
  ALTERNATIVE_FIELDS_MESSAGE,
  NON_CHATBOT_EVENT,
  AT_MENTION_MESSAGE,
  NO_AT_MENTION_MESSAGE,
  FILE_MESSAGE,
  FILE_MESSAGE_ALT,
  IMAGE_MESSAGE,
  IMAGE_MESSAGE_DOWNLOAD_CODE,
} from "../../test/fixtures/messages.js";

describe("extractChatbotMessage", () => {
  it("extracts standard chatbot message", () => {
    const result = extractChatbotMessage(BASIC_CHATBOT_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Hello, bot!");
    expect(result?.sessionWebhook).toContain("session=xxx");
    expect(result?.conversationId).toBe("cid123456");
    expect(result?.chatType).toBe("2");
    expect(result?.senderId).toBe("user001");
    expect(result?.senderName).toBe("Test User");
  });

  it("extracts direct message", () => {
    const result = extractChatbotMessage(DM_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Private message");
    expect(result?.chatType).toBe("1");
  });

  it("parses JSON string data", () => {
    const result = extractChatbotMessage(JSON_STRING_DATA_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Message from JSON string");
    expect(result?.conversationId).toBe("cid789");
  });

  it("handles alternative field names", () => {
    const result = extractChatbotMessage(ALTERNATIVE_FIELDS_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Using alternative fields");
  });

  it("returns null for non-chatbot events", () => {
    const result = extractChatbotMessage(NON_CHATBOT_EVENT);
    expect(result).toBeNull();
  });

  it("returns null for message without text", () => {
    const noTextMessage = {
      type: "CALLBACK",
      headers: { topic: "/v1.0/im/bot/messages/get" },
      data: { sessionWebhook: "https://example.com" },
    };
    const result = extractChatbotMessage(noTextMessage);
    expect(result).toBeNull();
  });

  it("handles nested text content", () => {
    const nestedMessage = {
      type: "CALLBACK",
      headers: { topic: "/v1.0/im/bot/messages/get", eventType: "CHATBOT_MESSAGE" },
      data: {
        text: { content: "Nested content" },
        sessionWebhook: "https://example.com",
      },
    };
    const result = extractChatbotMessage(nestedMessage);
    expect(result?.text).toBe("Nested content");
  });

  it("extracts message ID from various paths", () => {
    // headers.messageId
    expect(extractChatbotMessage(BASIC_CHATBOT_MESSAGE)?.messageId).toBe("msg-001");

    // headers.message_id
    const snakeCase = {
      ...BASIC_CHATBOT_MESSAGE,
      headers: { ...BASIC_CHATBOT_MESSAGE.headers, messageId: undefined, message_id: "snake-id" },
    };
    expect(extractChatbotMessage(snakeCase as any)?.messageId).toBe("snake-id");
  });

  it("extracts conversation ID from various paths", () => {
    // conversationId
    expect(extractChatbotMessage(BASIC_CHATBOT_MESSAGE)?.conversationId).toBe("cid123456");

    // openConversationId
    const openConvMessage = {
      type: "CALLBACK",
      headers: { topic: "/v1.0/im/bot/messages/get", eventType: "CHATBOT_MESSAGE" },
      data: {
        text: { content: "Test" },
        sessionWebhook: "https://example.com",
        openConversationId: "openCid123",
      },
    };
    expect(extractChatbotMessage(openConvMessage)?.conversationId).toBe("openCid123");
  });

  it("extracts @mention (atUsers) from message", () => {
    const result = extractChatbotMessage(AT_MENTION_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.atUsers).toHaveLength(1);
    expect(result?.atUsers[0].dingtalkId).toBe("bot-dingtalk-id");
    expect(result?.atUsers[0].staffId).toBe("bot-staff-id");
    expect(result?.isInAtList).toBe(true);
  });

  it("returns empty atUsers when not mentioned", () => {
    const result = extractChatbotMessage(NO_AT_MENTION_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.atUsers).toHaveLength(0);
    expect(result?.isInAtList).toBe(false);
  });

  it("defaults atUsers and isInAtList for messages without these fields", () => {
    const result = extractChatbotMessage(BASIC_CHATBOT_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.atUsers).toEqual([]);
    expect(result?.isInAtList).toBe(false);
  });

  it("extracts file message fields from content path", () => {
    const result = extractChatbotMessage(FILE_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.downloadCode).toBe("abc123downloadcode");
    expect(result?.fileName).toBe("document.pdf");
    expect(result?.fileType).toBe("pdf");
  });

  it("extracts file message fields from alternative paths", () => {
    const result = extractChatbotMessage(FILE_MESSAGE_ALT);
    expect(result).not.toBeNull();
    expect(result?.downloadCode).toBe("xyz789downloadcode");
    expect(result?.fileName).toBe("report.xlsx");
    expect(result?.fileType).toBe("xlsx");
    expect(result?.text).toBe("请查看附件");
  });

  it("parses file message even without text content", () => {
    const result = extractChatbotMessage(FILE_MESSAGE);
    expect(result).not.toBeNull();
    // File messages without explicit text will have content object stringified
    // The important thing is that file fields are extracted
    expect(result?.downloadCode).toBe("abc123downloadcode");
    expect(result?.fileName).toBe("document.pdf");
  });

  it("returns empty text for file-only messages", () => {
    const result = extractChatbotMessage(FILE_MESSAGE);
    expect(result?.text).toBe("");
  });

  it("extracts image message with picURL", () => {
    const result = extractChatbotMessage(IMAGE_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.picUrl).toBe("https://example.com/image.png");
    expect(result?.text).toBe("");
  });

  it("extracts image message with downloadCode", () => {
    const result = extractChatbotMessage(IMAGE_MESSAGE_DOWNLOAD_CODE);
    expect(result).not.toBeNull();
    expect(result?.picUrl).toBe("img123downloadcode");
    expect(result?.text).toBe("看这张图片");
  });

  it("parses image-only message without text", () => {
    const result = extractChatbotMessage(IMAGE_MESSAGE);
    expect(result).not.toBeNull();
    // Image-only messages should still be processed
    expect(result?.picUrl).toBeDefined();
  });
});

describe("buildSessionKey", () => {
  it("builds group session key", () => {
    const chat = extractChatbotMessage(BASIC_CHATBOT_MESSAGE)!;
    const key = buildSessionKey(chat);
    expect(key).toBe("agent:main:dingtalk:group:cid123456");
  });

  it("isolates group session key by sender when enabled", () => {
    const chat = extractChatbotMessage(BASIC_CHATBOT_MESSAGE)!;
    const key = buildSessionKey(chat, "main", { isolateGroupBySender: true });
    expect(key).toBe("agent:main:dingtalk:group:cid123456:user:user001");
  });

  it("builds DM session key", () => {
    const chat = extractChatbotMessage(DM_MESSAGE)!;
    const key = buildSessionKey(chat);
    expect(key).toBe("agent:main:dingtalk:dm:user002");
  });

  it("uses custom agent ID", () => {
    const chat = extractChatbotMessage(BASIC_CHATBOT_MESSAGE)!;
    const key = buildSessionKey(chat, "custom-agent");
    expect(key).toBe("agent:custom-agent:dingtalk:group:cid123456");
  });

  it("handles missing conversationId", () => {
    const chat = {
      messageId: "msg",
      eventType: "CHATBOT_MESSAGE",
      text: "Hello",
      sessionWebhook: "",
      conversationId: "",
      chatType: "2",
      senderId: "user",
      senderName: "User",
      raw: {},
      atUsers: [],
      isInAtList: false,
    };
    const key = buildSessionKey(chat);
    expect(key).toContain("unknownConv");
  });

  it("handles missing senderId for DM", () => {
    const chat = {
      messageId: "msg",
      eventType: "CHATBOT_MESSAGE",
      text: "Hello",
      sessionWebhook: "",
      conversationId: "conv",
      chatType: "1",
      senderId: "",
      senderName: "",
      raw: {},
      atUsers: [],
      isInAtList: false,
    };
    const key = buildSessionKey(chat);
    expect(key).toContain("unknownSender");
  });

  it("detects group chat from various chatType values", () => {
    const baseChat = {
      messageId: "msg",
      eventType: "CHATBOT_MESSAGE",
      text: "Hello",
      sessionWebhook: "",
      conversationId: "conv",
      senderId: "user",
      senderName: "User",
      raw: {},
      atUsers: [],
      isInAtList: false,
    };

    expect(buildSessionKey({ ...baseChat, chatType: "group" })).toContain("dingtalk:group:");
    expect(buildSessionKey({ ...baseChat, chatType: "2" })).toContain("dingtalk:group:");
    expect(buildSessionKey({ ...baseChat, chatType: "multi" })).toContain("dingtalk:group:");
    expect(buildSessionKey({ ...baseChat, chatType: "chat" })).toContain("dingtalk:group:");
  });
});

describe("startsWithPrefix", () => {
  it("returns true when no prefix required", () => {
    expect(startsWithPrefix("Hello", undefined)).toBe(true);
    expect(startsWithPrefix("Hello", "")).toBe(true);
  });

  it("returns true when text starts with prefix", () => {
    expect(startsWithPrefix("@bot Hello", "@bot")).toBe(true);
    expect(startsWithPrefix("@BOT Hello", "@bot")).toBe(true);
    expect(startsWithPrefix("@bot", "@bot")).toBe(true);
  });

  it("returns false when text does not start with prefix", () => {
    expect(startsWithPrefix("Hello @bot", "@bot")).toBe(false);
    expect(startsWithPrefix("Hello", "@bot")).toBe(false);
  });

  it("handles whitespace in text", () => {
    expect(startsWithPrefix("  @bot Hello", "@bot")).toBe(true);
  });

  it("handles whitespace in prefix", () => {
    expect(startsWithPrefix("@bot Hello", "  @bot  ")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(startsWithPrefix("BOT Hello", "bot")).toBe(true);
    expect(startsWithPrefix("bot Hello", "BOT")).toBe(true);
  });
});
