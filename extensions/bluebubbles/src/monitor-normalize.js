import { parseFiniteNumber } from "openclaw/plugin-sdk/bluebubbles";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readString(record, key) {
  if (!record) {
    return void 0;
  }
  const value = record[key];
  return typeof value === "string" ? value : void 0;
}
function readNumber(record, key) {
  if (!record) {
    return void 0;
  }
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function readBoolean(record, key) {
  if (!record) {
    return void 0;
  }
  const value = record[key];
  return typeof value === "boolean" ? value : void 0;
}
function readNumberLike(record, key) {
  if (!record) {
    return void 0;
  }
  return parseFiniteNumber(record[key]);
}
function extractAttachments(message) {
  const raw = message["attachments"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    out.push({
      guid: readString(record, "guid"),
      uti: readString(record, "uti"),
      mimeType: readString(record, "mimeType") ?? readString(record, "mime_type"),
      transferName: readString(record, "transferName") ?? readString(record, "transfer_name"),
      totalBytes: readNumberLike(record, "totalBytes") ?? readNumberLike(record, "total_bytes"),
      height: readNumberLike(record, "height"),
      width: readNumberLike(record, "width"),
      originalROWID: readNumberLike(record, "originalROWID") ?? readNumberLike(record, "rowid")
    });
  }
  return out;
}
function buildAttachmentPlaceholder(attachments) {
  if (attachments.length === 0) {
    return "";
  }
  const mimeTypes = attachments.map((entry) => entry.mimeType ?? "");
  const allImages = mimeTypes.every((entry) => entry.startsWith("image/"));
  const allVideos = mimeTypes.every((entry) => entry.startsWith("video/"));
  const allAudio = mimeTypes.every((entry) => entry.startsWith("audio/"));
  const tag = allImages ? "<media:image>" : allVideos ? "<media:video>" : allAudio ? "<media:audio>" : "<media:attachment>";
  const label = allImages ? "image" : allVideos ? "video" : allAudio ? "audio" : "file";
  const suffix = attachments.length === 1 ? label : `${label}s`;
  return `${tag} (${attachments.length} ${suffix})`;
}
function buildMessagePlaceholder(message) {
  const attachmentPlaceholder = buildAttachmentPlaceholder(message.attachments ?? []);
  if (attachmentPlaceholder) {
    return attachmentPlaceholder;
  }
  if (message.balloonBundleId) {
    return "<media:sticker>";
  }
  return "";
}
function formatReplyTag(message) {
  const rawId = message.replyToShortId || message.replyToId;
  if (!rawId) {
    return null;
  }
  return `[[reply_to:${rawId}]]`;
}
function extractReplyMetadata(message) {
  const replyRaw = message["replyTo"] ?? message["reply_to"] ?? message["replyToMessage"] ?? message["reply_to_message"] ?? message["repliedMessage"] ?? message["quotedMessage"] ?? message["associatedMessage"] ?? message["reply"];
  const replyRecord = asRecord(replyRaw);
  const replyHandle = asRecord(replyRecord?.["handle"]) ?? asRecord(replyRecord?.["sender"]) ?? null;
  const replySenderRaw = readString(replyHandle, "address") ?? readString(replyHandle, "handle") ?? readString(replyHandle, "id") ?? readString(replyRecord, "senderId") ?? readString(replyRecord, "sender") ?? readString(replyRecord, "from");
  const normalizedSender = replySenderRaw ? normalizeBlueBubblesHandle(replySenderRaw) || replySenderRaw.trim() : void 0;
  const replyToBody = readString(replyRecord, "text") ?? readString(replyRecord, "body") ?? readString(replyRecord, "message") ?? readString(replyRecord, "subject") ?? void 0;
  const directReplyId = readString(message, "replyToMessageGuid") ?? readString(message, "replyToGuid") ?? readString(message, "replyGuid") ?? readString(message, "selectedMessageGuid") ?? readString(message, "selectedMessageId") ?? readString(message, "replyToMessageId") ?? readString(message, "replyId") ?? readString(replyRecord, "guid") ?? readString(replyRecord, "id") ?? readString(replyRecord, "messageId");
  const associatedType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
  const associatedGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId");
  const isReactionAssociation = typeof associatedType === "number" && REACTION_TYPE_MAP.has(associatedType);
  const replyToId = directReplyId ?? (!isReactionAssociation ? associatedGuid : void 0);
  const threadOriginatorGuid = readString(message, "threadOriginatorGuid");
  const messageGuid = readString(message, "guid");
  const fallbackReplyId = !replyToId && threadOriginatorGuid && threadOriginatorGuid !== messageGuid ? threadOriginatorGuid : void 0;
  return {
    replyToId: (replyToId ?? fallbackReplyId)?.trim() || void 0,
    replyToBody: replyToBody?.trim() || void 0,
    replyToSender: normalizedSender || void 0
  };
}
function readFirstChatRecord(message) {
  const chats = message["chats"];
  if (!Array.isArray(chats) || chats.length === 0) {
    return null;
  }
  const first = chats[0];
  return asRecord(first);
}
function extractSenderInfo(message) {
  const handleValue = message.handle ?? message.sender;
  const handle = asRecord(handleValue) ?? (typeof handleValue === "string" ? { address: handleValue } : null);
  const senderIdRaw = readString(handle, "address") ?? readString(handle, "handle") ?? readString(handle, "id") ?? readString(message, "senderId") ?? readString(message, "sender") ?? readString(message, "from") ?? "";
  const senderId = senderIdRaw.trim();
  const senderName = readString(handle, "displayName") ?? readString(handle, "name") ?? readString(message, "senderName") ?? void 0;
  return {
    senderId,
    senderIdExplicit: Boolean(senderId),
    senderName
  };
}
function extractChatContext(message) {
  const chat = asRecord(message.chat) ?? asRecord(message.conversation) ?? null;
  const chatFromList = readFirstChatRecord(message);
  const chatGuid = readString(message, "chatGuid") ?? readString(message, "chat_guid") ?? readString(chat, "chatGuid") ?? readString(chat, "chat_guid") ?? readString(chat, "guid") ?? readString(chatFromList, "chatGuid") ?? readString(chatFromList, "chat_guid") ?? readString(chatFromList, "guid");
  const chatIdentifier = readString(message, "chatIdentifier") ?? readString(message, "chat_identifier") ?? readString(chat, "chatIdentifier") ?? readString(chat, "chat_identifier") ?? readString(chat, "identifier") ?? readString(chatFromList, "chatIdentifier") ?? readString(chatFromList, "chat_identifier") ?? readString(chatFromList, "identifier") ?? extractChatIdentifierFromChatGuid(chatGuid);
  const chatId = readNumberLike(message, "chatId") ?? readNumberLike(message, "chat_id") ?? readNumberLike(chat, "chatId") ?? readNumberLike(chat, "chat_id") ?? readNumberLike(chat, "id") ?? readNumberLike(chatFromList, "chatId") ?? readNumberLike(chatFromList, "chat_id") ?? readNumberLike(chatFromList, "id");
  const chatName = readString(message, "chatName") ?? readString(chat, "displayName") ?? readString(chat, "name") ?? readString(chatFromList, "displayName") ?? readString(chatFromList, "name") ?? void 0;
  const chatParticipants = chat ? chat["participants"] : void 0;
  const messageParticipants = message["participants"];
  const chatsParticipants = chatFromList ? chatFromList["participants"] : void 0;
  const participants = Array.isArray(chatParticipants) ? chatParticipants : Array.isArray(messageParticipants) ? messageParticipants : Array.isArray(chatsParticipants) ? chatsParticipants : [];
  const participantsCount = participants.length;
  const groupFromChatGuid = resolveGroupFlagFromChatGuid(chatGuid);
  const explicitIsGroup = readBoolean(message, "isGroup") ?? readBoolean(message, "is_group") ?? readBoolean(chat, "isGroup") ?? readBoolean(message, "group");
  const isGroup = typeof groupFromChatGuid === "boolean" ? groupFromChatGuid : explicitIsGroup ?? participantsCount > 2;
  return {
    chatGuid,
    chatIdentifier,
    chatId,
    chatName,
    isGroup,
    participants
  };
}
function normalizeParticipantEntry(entry) {
  if (typeof entry === "string" || typeof entry === "number") {
    const raw = String(entry).trim();
    if (!raw) {
      return null;
    }
    const normalized = normalizeBlueBubblesHandle(raw) || raw;
    return normalized ? { id: normalized } : null;
  }
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const nestedHandle = asRecord(record["handle"]) ?? asRecord(record["sender"]) ?? asRecord(record["contact"]) ?? null;
  const idRaw = readString(record, "address") ?? readString(record, "handle") ?? readString(record, "id") ?? readString(record, "phoneNumber") ?? readString(record, "phone_number") ?? readString(record, "email") ?? readString(nestedHandle, "address") ?? readString(nestedHandle, "handle") ?? readString(nestedHandle, "id");
  const nameRaw = readString(record, "displayName") ?? readString(record, "name") ?? readString(record, "title") ?? readString(nestedHandle, "displayName") ?? readString(nestedHandle, "name");
  const normalizedId = idRaw ? normalizeBlueBubblesHandle(idRaw) || idRaw.trim() : "";
  if (!normalizedId) {
    return null;
  }
  const name = nameRaw?.trim() || void 0;
  return { id: normalizedId, name };
}
function normalizeParticipantList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const entry of raw) {
    const normalized = normalizeParticipantEntry(entry);
    if (!normalized?.id) {
      continue;
    }
    const key = normalized.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}
function formatGroupMembers(params) {
  const seen = /* @__PURE__ */ new Set();
  const ordered = [];
  for (const entry of params.participants ?? []) {
    if (!entry?.id) {
      continue;
    }
    const key = entry.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(entry);
  }
  if (ordered.length === 0 && params.fallback?.id) {
    ordered.push(params.fallback);
  }
  if (ordered.length === 0) {
    return void 0;
  }
  return ordered.map((entry) => entry.name ? `${entry.name} (${entry.id})` : entry.id).join(", ");
}
function resolveGroupFlagFromChatGuid(chatGuid) {
  const guid = chatGuid?.trim();
  if (!guid) {
    return void 0;
  }
  const parts = guid.split(";");
  if (parts.length >= 3) {
    if (parts[1] === "+") {
      return true;
    }
    if (parts[1] === "-") {
      return false;
    }
  }
  if (guid.includes(";+;")) {
    return true;
  }
  if (guid.includes(";-;")) {
    return false;
  }
  return void 0;
}
function extractChatIdentifierFromChatGuid(chatGuid) {
  const guid = chatGuid?.trim();
  if (!guid) {
    return void 0;
  }
  const parts = guid.split(";");
  if (parts.length < 3) {
    return void 0;
  }
  const identifier = parts[2]?.trim();
  return identifier || void 0;
}
function formatGroupAllowlistEntry(params) {
  const guid = params.chatGuid?.trim();
  if (guid) {
    return `chat_guid:${guid}`;
  }
  const chatId = params.chatId;
  if (typeof chatId === "number" && Number.isFinite(chatId)) {
    return `chat_id:${chatId}`;
  }
  const identifier = params.chatIdentifier?.trim();
  if (identifier) {
    return `chat_identifier:${identifier}`;
  }
  return null;
}
const REACTION_TYPE_MAP = /* @__PURE__ */ new Map([
  [2e3, { emoji: "\u2764\uFE0F", action: "added" }],
  [2001, { emoji: "\u{1F44D}", action: "added" }],
  [2002, { emoji: "\u{1F44E}", action: "added" }],
  [2003, { emoji: "\u{1F602}", action: "added" }],
  [2004, { emoji: "\u203C\uFE0F", action: "added" }],
  [2005, { emoji: "\u2753", action: "added" }],
  [3e3, { emoji: "\u2764\uFE0F", action: "removed" }],
  [3001, { emoji: "\u{1F44D}", action: "removed" }],
  [3002, { emoji: "\u{1F44E}", action: "removed" }],
  [3003, { emoji: "\u{1F602}", action: "removed" }],
  [3004, { emoji: "\u203C\uFE0F", action: "removed" }],
  [3005, { emoji: "\u2753", action: "removed" }]
]);
const TAPBACK_TEXT_MAP = /* @__PURE__ */ new Map([
  ["loved", { emoji: "\u2764\uFE0F", action: "added" }],
  ["liked", { emoji: "\u{1F44D}", action: "added" }],
  ["disliked", { emoji: "\u{1F44E}", action: "added" }],
  ["laughed at", { emoji: "\u{1F602}", action: "added" }],
  ["emphasized", { emoji: "\u203C\uFE0F", action: "added" }],
  ["questioned", { emoji: "\u2753", action: "added" }],
  // Removal patterns (e.g., "Removed a heart from")
  ["removed a heart from", { emoji: "\u2764\uFE0F", action: "removed" }],
  ["removed a like from", { emoji: "\u{1F44D}", action: "removed" }],
  ["removed a dislike from", { emoji: "\u{1F44E}", action: "removed" }],
  ["removed a laugh from", { emoji: "\u{1F602}", action: "removed" }],
  ["removed an emphasis from", { emoji: "\u203C\uFE0F", action: "removed" }],
  ["removed a question from", { emoji: "\u2753", action: "removed" }]
]);
const TAPBACK_EMOJI_REGEX = /(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/u;
function extractFirstEmoji(text) {
  const match = text.match(TAPBACK_EMOJI_REGEX);
  return match ? match[0] : null;
}
function extractQuotedTapbackText(text) {
  const match = text.match(/[“"]([^”"]+)[”"]/s);
  return match ? match[1] : null;
}
function isTapbackAssociatedType(type) {
  return typeof type === "number" && Number.isFinite(type) && type >= 2e3 && type < 4e3;
}
function resolveTapbackActionHint(type) {
  if (typeof type !== "number" || !Number.isFinite(type)) {
    return void 0;
  }
  if (type >= 3e3 && type < 4e3) {
    return "removed";
  }
  if (type >= 2e3 && type < 3e3) {
    return "added";
  }
  return void 0;
}
function resolveTapbackContext(message) {
  const associatedType = message.associatedMessageType;
  const hasTapbackType = isTapbackAssociatedType(associatedType);
  const hasTapbackMarker = Boolean(message.associatedMessageEmoji) || Boolean(message.isTapback);
  if (!hasTapbackType && !hasTapbackMarker) {
    return null;
  }
  const replyToId = message.associatedMessageGuid?.trim() || message.replyToId?.trim() || void 0;
  const actionHint = resolveTapbackActionHint(associatedType);
  const emojiHint = message.associatedMessageEmoji?.trim() || REACTION_TYPE_MAP.get(associatedType ?? -1)?.emoji;
  return { emojiHint, actionHint, replyToId };
}
function parseTapbackText(params) {
  const trimmed = params.text.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) {
    return null;
  }
  const parseLeadingReactionAction = (prefix, defaultAction) => {
    if (!lower.startsWith(prefix)) {
      return null;
    }
    const emoji = extractFirstEmoji(trimmed) ?? params.emojiHint;
    if (!emoji) {
      return null;
    }
    const quotedText = extractQuotedTapbackText(trimmed);
    if (params.requireQuoted && !quotedText) {
      return null;
    }
    const fallback = trimmed.slice(prefix.length).trim();
    return {
      emoji,
      action: params.actionHint ?? defaultAction,
      quotedText: quotedText ?? fallback
    };
  };
  for (const [pattern, { emoji, action }] of TAPBACK_TEXT_MAP) {
    if (lower.startsWith(pattern)) {
      const afterPattern = trimmed.slice(pattern.length).trim();
      if (params.requireQuoted) {
        const strictMatch = afterPattern.match(/^[“"](.+)[”"]$/s);
        if (!strictMatch) {
          return null;
        }
        return { emoji, action, quotedText: strictMatch[1] };
      }
      const quotedText = extractQuotedTapbackText(afterPattern) ?? extractQuotedTapbackText(trimmed) ?? afterPattern;
      return { emoji, action, quotedText };
    }
  }
  const reacted = parseLeadingReactionAction("reacted", "added");
  if (reacted) {
    return reacted;
  }
  const removed = parseLeadingReactionAction("removed", "removed");
  if (removed) {
    return removed;
  }
  return null;
}
function extractMessagePayload(payload) {
  const parseRecord = (value) => {
    const record = asRecord(value);
    if (record) {
      return record;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsedEntry = parseRecord(entry);
        if (parsedEntry) {
          return parsedEntry;
        }
      }
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return parseRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  };
  const dataRaw = payload.data ?? payload.payload ?? payload.event;
  const data = parseRecord(dataRaw);
  const messageRaw = payload.message ?? data?.message ?? data;
  const message = parseRecord(messageRaw);
  if (message) {
    return message;
  }
  return null;
}
function normalizeWebhookMessage(payload) {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }
  const text = readString(message, "text") ?? readString(message, "body") ?? readString(message, "subject") ?? "";
  const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
  const { chatGuid, chatIdentifier, chatId, chatName, isGroup, participants } = extractChatContext(message);
  const normalizedParticipants = normalizeParticipantList(participants);
  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const messageId = readString(message, "guid") ?? readString(message, "id") ?? readString(message, "messageId") ?? void 0;
  const balloonBundleId = readString(message, "balloonBundleId");
  const associatedMessageGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId") ?? void 0;
  const associatedMessageType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
  const associatedMessageEmoji = readString(message, "associatedMessageEmoji") ?? readString(message, "associated_message_emoji") ?? readString(message, "reactionEmoji") ?? readString(message, "reaction_emoji") ?? void 0;
  const isTapback = readBoolean(message, "isTapback") ?? readBoolean(message, "is_tapback") ?? readBoolean(message, "tapback") ?? void 0;
  const timestampRaw = readNumber(message, "date") ?? readNumber(message, "dateCreated") ?? readNumber(message, "timestamp");
  const timestamp = typeof timestampRaw === "number" ? timestampRaw > 1e12 ? timestampRaw : timestampRaw * 1e3 : void 0;
  const senderFallbackFromChatGuid = !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }
  const replyMetadata = extractReplyMetadata(message);
  return {
    text,
    senderId: normalizedSender,
    senderIdExplicit,
    senderName,
    messageId,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
    attachments: extractAttachments(message),
    balloonBundleId,
    associatedMessageGuid,
    associatedMessageType,
    associatedMessageEmoji,
    isTapback,
    participants: normalizedParticipants,
    replyToId: replyMetadata.replyToId,
    replyToBody: replyMetadata.replyToBody,
    replyToSender: replyMetadata.replyToSender
  };
}
function normalizeWebhookReaction(payload) {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }
  const associatedGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId");
  const associatedType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
  if (!associatedGuid || associatedType === void 0) {
    return null;
  }
  const mapping = REACTION_TYPE_MAP.get(associatedType);
  const associatedEmoji = readString(message, "associatedMessageEmoji") ?? readString(message, "associated_message_emoji") ?? readString(message, "reactionEmoji") ?? readString(message, "reaction_emoji");
  const emoji = (associatedEmoji?.trim() || mapping?.emoji) ?? `reaction:${associatedType}`;
  const action = mapping?.action ?? resolveTapbackActionHint(associatedType) ?? "added";
  const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
  const { chatGuid, chatIdentifier, chatId, chatName, isGroup } = extractChatContext(message);
  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const timestampRaw = readNumberLike(message, "date") ?? readNumberLike(message, "dateCreated") ?? readNumberLike(message, "timestamp");
  const timestamp = typeof timestampRaw === "number" ? timestampRaw > 1e12 ? timestampRaw : timestampRaw * 1e3 : void 0;
  const senderFallbackFromChatGuid = !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }
  return {
    action,
    emoji,
    senderId: normalizedSender,
    senderIdExplicit,
    senderName,
    messageId: associatedGuid,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe
  };
}
export {
  buildMessagePlaceholder,
  formatGroupAllowlistEntry,
  formatGroupMembers,
  formatReplyTag,
  normalizeWebhookMessage,
  normalizeWebhookReaction,
  parseTapbackText,
  resolveGroupFlagFromChatGuid,
  resolveTapbackContext
};
