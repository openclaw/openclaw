/**
 * Message fixtures for DingTalk stream message testing.
 */

import type { RawStreamMessage, ChatbotMessage } from "../../src/stream/types.js";

/**
 * Standard chatbot message via sessionWebhook.
 */
export const BASIC_CHATBOT_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-001",
  },
  data: {
    text: { content: "Hello, bot!" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
    conversationId: "cid123456",
    conversationType: "2",
    senderStaffId: "user001",
    senderNick: "Test User",
  },
};

/**
 * Direct message (1:1 chat).
 */
export const DM_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-002",
  },
  data: {
    text: { content: "Private message" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=yyy",
    conversationId: "dm456",
    conversationType: "1",
    senderStaffId: "user002",
    senderNick: "DM User",
  },
};

/**
 * Message with JSON string data (common in DingTalk).
 */
export const JSON_STRING_DATA_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-003",
  },
  data: JSON.stringify({
    text: { content: "Message from JSON string" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=zzz",
    conversationId: "cid789",
    conversationType: "2",
    senderStaffId: "user003",
    senderNick: "JSON User",
  }),
};

/**
 * Message using alternative field names.
 */
export const ALTERNATIVE_FIELDS_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    event_type: "CHATBOT_MESSAGE",
    message_id: "msg-004",
  },
  data: {
    content: "Using alternative fields",
    session_webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=alt",
    conversation_id: "alt123",
    chat_type: "group",
    sender: {
      staffId: "user004",
      nick: "Alt User",
    },
  },
};

/**
 * Message with prefix required for group.
 */
export const PREFIXED_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-005",
  },
  data: {
    text: { content: "@bot Hello with prefix" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=ppp",
    conversationId: "cidprefix",
    conversationType: "2",
    senderStaffId: "user005",
    senderNick: "Prefix User",
  },
};

/**
 * Non-chatbot event (should be ignored).
 */
export const NON_CHATBOT_EVENT: RawStreamMessage = {
  type: "EVENT",
  headers: {
    topic: "/v1.0/contact/user/update",
    eventType: "USER_UPDATE",
    messageId: "evt-001",
  },
  data: {
    userId: "user001",
    name: "Updated Name",
  },
};

/**
 * Expected parsed result for BASIC_CHATBOT_MESSAGE.
 */
export const EXPECTED_BASIC_CHAT: ChatbotMessage = {
  messageId: "msg-001",
  eventType: "CHATBOT_MESSAGE",
  text: "Hello, bot!",
  sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
  conversationId: "cid123456",
  chatType: "2",
  senderId: "user001",
  senderName: "Test User",
  raw: BASIC_CHATBOT_MESSAGE,
  atUsers: [],
  isInAtList: false,
};

/**
 * Message with @提及 (at mention).
 */
export const AT_MENTION_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-at-001",
  },
  data: {
    text: { content: "@机器人 请帮我查询" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=at",
    conversationId: "cid-at-123",
    conversationType: "2",
    senderStaffId: "user-at-001",
    senderNick: "At User",
    atUsers: [{ dingtalkId: "bot-dingtalk-id", staffId: "bot-staff-id" }],
    isInAtList: true,
  },
};

/**
 * Message without @提及 in group.
 */
export const NO_AT_MENTION_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-no-at-001",
  },
  data: {
    text: { content: "普通群聊消息" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=noat",
    conversationId: "cid-no-at-123",
    conversationType: "2",
    senderStaffId: "user-no-at-001",
    senderNick: "No At User",
    atUsers: [],
    isInAtList: false,
  },
};

/**
 * File message with download code.
 */
export const FILE_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-file-001",
  },
  data: {
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=file",
    conversationId: "cid-file-123",
    conversationType: "1",
    senderStaffId: "user-file-001",
    senderNick: "File User",
    content: {
      downloadCode: "abc123downloadcode",
      fileName: "document.pdf",
      fileType: "pdf",
    },
    msgType: "file",
  },
};

/**
 * File message with alternative field paths.
 */
export const FILE_MESSAGE_ALT: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-file-002",
  },
  data: {
    text: { content: "请查看附件" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=file2",
    conversationId: "cid-file-456",
    conversationType: "2",
    senderStaffId: "user-file-002",
    senderNick: "File User 2",
    downloadCode: "xyz789downloadcode",
    fileName: "report.xlsx",
    fileType: "xlsx",
  },
};

/**
 * Image message with picURL.
 */
export const IMAGE_MESSAGE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-image-001",
  },
  data: {
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=img",
    conversationId: "cid-image-123",
    conversationType: "1",
    senderStaffId: "user-image-001",
    senderNick: "Image User",
    content: {
      picURL: "https://example.com/image.png",
    },
    msgType: "picture",
  },
};

/**
 * Image message with downloadCode (alternative format).
 */
export const IMAGE_MESSAGE_DOWNLOAD_CODE: RawStreamMessage = {
  type: "CALLBACK",
  headers: {
    topic: "/v1.0/im/bot/messages/get",
    eventType: "CHATBOT_MESSAGE",
    messageId: "msg-image-002",
  },
  data: {
    text: { content: "看这张图片" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=img2",
    conversationId: "cid-image-456",
    conversationType: "2",
    senderStaffId: "user-image-002",
    senderNick: "Image User 2",
    content: {
      downloadCode: "img123downloadcode",
    },
    msgType: "picture",
  },
};
