/**
 * Multi-path field extraction for DingTalk's unstable API schemas.
 * DingTalk stream payloads can have different field names/paths across versions.
 */

import type { AtUser, ChatbotMessage, RawStreamMessage } from "./types.js";

/**
 * Safely access nested object property by dot-separated path.
 */
function get(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Try multiple paths and return the first non-empty value.
 */
function first(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    const v = get(obj, p);
    if (v !== undefined && v !== null && v !== "") {
      return v;
    }
  }
  return undefined;
}

/**
 * Convert value to string, handling null/undefined.
 */
function asString(v: unknown): string {
  if (v === undefined || v === null) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return `${v}`;
  }
  if (typeof v === "symbol") {
    return v.description ?? "";
  }
  return "";
}

/**
 * Convert value to boolean.
 */
function asBool(v: unknown): boolean {
  if (v === undefined || v === null) {
    return false;
  }
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    return v.toLowerCase() === "true" || v === "1";
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  return Boolean(v);
}

/**
 * Parse atUsers array from raw data.
 */
function parseAtUsers(data: unknown): AtUser[] {
  const raw = first(data, ["atUsers", "at_users"]);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is Record<string, unknown> => item && typeof item === "object")
    .map((item) => ({
      dingtalkId: asString(
        item.dingtalkId ?? item.dingtalk_id ?? item.userId ?? item.user_id ?? "",
      ),
      staffId: asString(item.staffId ?? item.staff_id ?? "") || undefined,
    }))
    .filter((user) => user.dingtalkId);
}

/**
 * Extract chatbot message from raw stream event.
 * Returns null if this doesn't look like a chatbot message.
 */
export function extractChatbotMessage(raw: RawStreamMessage): ChatbotMessage | null {
  // Common wrappers: { headers, data } / { header, payload } / etc
  const headers = raw?.headers ?? raw?.header ?? raw?.meta ?? {};
  let data: unknown = raw?.data ?? raw?.payload ?? raw?.body ?? raw?.event ?? raw?.content ?? raw;

  // DingTalk Stream may wrap data as a JSON string - parse it
  if (typeof data === "string" && data.startsWith("{")) {
    try {
      data = JSON.parse(data);
    } catch {
      // ignore parse errors
    }
  }

  const eventType = asString(
    first(raw, [
      "type",
      "eventType",
      "event_type",
      "headers.eventType",
      "headers.event_type",
      "header.eventType",
      "header.event_type",
      "headers.type",
    ]),
  );

  const messageId = asString(
    first(raw, [
      "headers.messageId",
      "headers.message_id",
      "header.messageId",
      "header.message_id",
      "messageId",
      "message_id",
      "id",
      "uuid",
    ]),
  );

  const sessionWebhook = asString(
    first(data, [
      "sessionWebhook",
      "session_webhook",
      "conversationSessionWebhook",
      "conversation.sessionWebhook",
      "context.sessionWebhook",
      "webhook",
    ]),
  );

  // Try multiple paths for text content
  const text = asString(
    first(data, [
      "text.content",
      "text",
      "content.text",
      "content",
      "message.text",
      "msg.text",
      "data.text",
      "data.text.content",
    ]),
  );

  const conversationId = asString(
    first(data, [
      "conversationId",
      "conversation_id",
      "conversation.conversationId",
      "conversation.id",
      "chatId",
      "chat_id",
      "openConversationId",
      "open_conversation_id",
    ]),
  );

  const chatType = asString(
    first(data, [
      "conversationType",
      "conversation_type",
      "conversation.conversationType",
      "chatType",
      "chat_type",
    ]),
  );

  const senderId = asString(
    first(data, [
      "senderStaffId",
      "sender.staffId",
      "senderId",
      "sender.id",
      "sender.userid",
      "userId",
      "user_id",
      "staffId",
    ]),
  );

  const senderName = asString(
    first(data, [
      "senderNick",
      "sender.nick",
      "sender.name",
      "senderName",
      "userName",
      "user_name",
    ]),
  );

  // DingTalk may wrap actual content in a JSON string
  let finalText = text;
  try {
    if (finalText && finalText.startsWith("{") && finalText.endsWith("}")) {
      const parsed = JSON.parse(finalText) as Record<string, unknown>;
      const maybe = asString(first(parsed, ["text.content", "content", "text"]));
      if (maybe) {
        finalText = maybe;
      }
    }
  } catch {
    // ignore
  }

  // Decide whether this looks like a chatbot message
  const looksLikeChatbot =
    Boolean(sessionWebhook) ||
    /chatbot|bot|im\.|message/i.test(eventType) ||
    /chatbot|bot/i.test(asString(first(headers, ["topic", "eventType", "type"])));

  // Parse 文件消息字段
  const msgType = asString(first(data, ["msgType", "msg_type", "messageType", "message_type"]));

  const downloadCode =
    asString(
      first(data, [
        "content.downloadCode",
        "downloadCode",
        "download_code",
        "fileDownloadCode",
        "file_download_code",
      ]),
    ) || undefined;

  const fileName =
    asString(first(data, ["content.fileName", "fileName", "file_name", "content.name", "name"])) ||
    undefined;

  const fileType =
    asString(
      first(data, [
        "content.fileType",
        "fileType",
        "file_type",
        "content.type",
        "msgType",
        "msg_type",
      ]),
    ) || undefined;

  // Parse 图片消息字段
  // 注意: 只有在不是文件消息时才从 content.downloadCode 提取 picUrl
  // 避免文件消息被错误地同时识别为图片消息
  const picUrlPaths = [
    "content.picURL",
    "picURL",
    "picture.downloadCode",
    "richText.0.text",
    "imageContent.downloadCode",
  ];
  // 仅当不是文件类型时，才从 content.downloadCode 提取 picUrl
  if (msgType !== "file") {
    picUrlPaths.splice(1, 0, "content.downloadCode");
  }
  const picUrl = asString(first(data, picUrlPaths)) || undefined;

  // For file/image messages, we may not have text content but should still process
  const hasFileContent = Boolean(downloadCode);
  const hasImageContent = Boolean(picUrl);
  if (!looksLikeChatbot) {
    return null;
  }
  if (!finalText && !hasFileContent && !hasImageContent) {
    return null;
  }

  // Parse @提及信息
  const atUsers = parseAtUsers(data);
  const isInAtList = asBool(
    first(data, ["isInAtList", "is_in_at_list", "isAtBot", "is_at_bot", "atSelf", "at_self"]),
  );

  return {
    messageId,
    eventType,
    text: finalText,
    sessionWebhook,
    conversationId,
    chatType,
    senderId,
    senderName,
    raw,
    atUsers,
    isInAtList,
    downloadCode,
    fileName,
    fileType,
    picUrl,
  };
}

/**
 * Build session key from chat message.
 * By default, groups share a conversation key, DMs use sender ID.
 * Optionally, group sessions can be isolated by sender (per-user context).
 * Uses agent:main: prefix for compatibility with clawdbot Control UI.
 */
export type BuildSessionKeyOptions = {
  /** When true, group chats will be isolated by senderId (per user). */
  isolateGroupBySender?: boolean;
};

export function buildSessionKey(
  chat: ChatbotMessage,
  agentId: string = "main",
  opts: BuildSessionKeyOptions = {},
): string {
  const conv = chat.conversationId || "unknownConv";
  const sender = chat.senderId || "unknownSender";
  const chatType = (chat.chatType || "").toLowerCase();
  const isGroup = /group|chat|2|multi/.test(chatType);
  const isolateGroupBySender = opts.isolateGroupBySender ?? false;
  const baseKey = isGroup
    ? isolateGroupBySender
      ? `dingtalk:group:${conv}:user:${sender}`
      : `dingtalk:group:${conv}`
    : `dingtalk:dm:${sender}`;
  return `agent:${agentId}:${baseKey}`;
}

/**
 * Check if message text starts with required prefix (case-insensitive).
 */
export function startsWithPrefix(text: string, prefix: string | undefined): boolean {
  if (!prefix) {
    return true;
  }
  return text.trim().toLowerCase().startsWith(prefix.trim().toLowerCase());
}
