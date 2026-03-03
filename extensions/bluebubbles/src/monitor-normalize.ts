import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
import type { BlueBubblesAttachment } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ParsedBoolean = {
  value: boolean;
  source: "boolean" | "number" | "string";
};

function hasDefinedProperty(record: Record<string, unknown> | null, key: string): boolean {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) {
    return false;
  }
  const value = record[key];
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanWithSource(
  record: Record<string, unknown> | null,
  key: string,
): ParsedBoolean | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === "boolean") {
    return { value, source: "boolean" };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) {
      return { value: true, source: "number" };
    }
    if (value === 0) {
      return { value: false, source: "number" };
    }
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(normalized)) {
      return { value: true, source: "string" };
    }
    if (["0", "false", "no", "n"].includes(normalized)) {
      return { value: false, source: "string" };
    }
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  return readBooleanWithSource(record, key)?.value;
}

function readFirstBooleanWithSource(
  candidates: Array<{ record: Record<string, unknown> | null; key: string }>,
): ParsedBoolean | undefined {
  for (const candidate of candidates) {
    const parsed = readBooleanWithSource(candidate.record, candidate.key);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function readNumberLike(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractAttachments(message: Record<string, unknown>): BlueBubblesAttachment[] {
  const raw = message["attachments"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: BlueBubblesAttachment[] = [];
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
      originalROWID: readNumberLike(record, "originalROWID") ?? readNumberLike(record, "rowid"),
    });
  }
  return out;
}

function buildAttachmentPlaceholder(attachments: BlueBubblesAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const mimeTypes = attachments.map((entry) => entry.mimeType ?? "");
  const allImages = mimeTypes.every((entry) => entry.startsWith("image/"));
  const allVideos = mimeTypes.every((entry) => entry.startsWith("video/"));
  const allAudio = mimeTypes.every((entry) => entry.startsWith("audio/"));
  const tag = allImages
    ? "<media:image>"
    : allVideos
      ? "<media:video>"
      : allAudio
        ? "<media:audio>"
        : "<media:attachment>";
  const label = allImages ? "image" : allVideos ? "video" : allAudio ? "audio" : "file";
  const suffix = attachments.length === 1 ? label : `${label}s`;
  return `${tag} (${attachments.length} ${suffix})`;
}

export function buildMessagePlaceholder(message: NormalizedWebhookMessage): string {
  const attachmentPlaceholder = buildAttachmentPlaceholder(message.attachments ?? []);
  if (attachmentPlaceholder) {
    return attachmentPlaceholder;
  }
  if (message.balloonBundleId) {
    return "<media:sticker>";
  }
  return "";
}

// Returns inline reply tag like "[[reply_to:4]]" for prepending to message body
export function formatReplyTag(message: {
  replyToId?: string;
  replyToShortId?: string;
}): string | null {
  // Prefer short ID
  const rawId = message.replyToShortId || message.replyToId;
  if (!rawId) {
    return null;
  }
  return `[[reply_to:${rawId}]]`;
}

function extractReplyMetadata(message: Record<string, unknown>): {
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
} {
  const replyRaw =
    message["replyTo"] ??
    message["reply_to"] ??
    message["replyToMessage"] ??
    message["reply_to_message"] ??
    message["repliedMessage"] ??
    message["quotedMessage"] ??
    message["associatedMessage"] ??
    message["reply"];
  const replyRecord = asRecord(replyRaw);
  const replyHandle =
    asRecord(replyRecord?.["handle"]) ?? asRecord(replyRecord?.["sender"]) ?? null;
  const replySenderRaw =
    readString(replyHandle, "address") ??
    readString(replyHandle, "handle") ??
    readString(replyHandle, "id") ??
    readString(replyRecord, "senderId") ??
    readString(replyRecord, "sender") ??
    readString(replyRecord, "from");
  const normalizedSender = replySenderRaw
    ? normalizeBlueBubblesHandle(replySenderRaw) || replySenderRaw.trim()
    : undefined;

  const replyToBody =
    readString(replyRecord, "text") ??
    readString(replyRecord, "body") ??
    readString(replyRecord, "message") ??
    readString(replyRecord, "subject") ??
    undefined;

  const directReplyId =
    readString(message, "replyToMessageGuid") ??
    readString(message, "reply_to_message_guid") ??
    readString(message, "replyToGuid") ??
    readString(message, "reply_to_guid") ??
    readString(message, "replyGuid") ??
    readString(message, "selectedMessageGuid") ??
    readString(message, "selected_message_guid") ??
    readString(message, "selectedMessageId") ??
    readString(message, "selected_message_id") ??
    readString(message, "replyToMessageId") ??
    readString(message, "reply_to_message_id") ??
    readString(message, "replyId") ??
    readString(message, "reply_id") ??
    readString(replyRecord, "guid") ??
    readString(replyRecord, "id") ??
    readString(replyRecord, "messageId") ??
    readString(replyRecord, "message_id");

  const associatedType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  const associatedGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId") ??
    readString(message, "associated_message_id");
  const isReactionAssociation =
    typeof associatedType === "number" && REACTION_TYPE_MAP.has(associatedType);

  const replyToId = directReplyId ?? (!isReactionAssociation ? associatedGuid : undefined);
  const threadOriginatorGuid =
    readString(message, "threadOriginatorGuid") ?? readString(message, "thread_originator_guid");
  const messageGuid =
    readString(message, "guid") ??
    readString(message, "messageGuid") ??
    readString(message, "message_guid");
  const fallbackReplyId =
    !replyToId && threadOriginatorGuid && threadOriginatorGuid !== messageGuid
      ? threadOriginatorGuid
      : undefined;

  return {
    replyToId: (replyToId ?? fallbackReplyId)?.trim() || undefined,
    replyToBody: replyToBody?.trim() || undefined,
    replyToSender: normalizedSender || undefined,
  };
}

function readFirstChatRecord(message: Record<string, unknown>): Record<string, unknown> | null {
  const chats = message["chats"];
  if (!Array.isArray(chats) || chats.length === 0) {
    return null;
  }
  const first = chats[0];
  return asRecord(first);
}

function extractSenderInfo(message: Record<string, unknown>): {
  senderId: string;
  senderName?: string;
} {
  const handleValue = message.handle ?? message.sender;
  const handle =
    asRecord(handleValue) ?? (typeof handleValue === "string" ? { address: handleValue } : null);
  const senderId =
    readString(handle, "address") ??
    readString(handle, "handle") ??
    readString(handle, "id") ??
    readString(message, "senderId") ??
    readString(message, "sender") ??
    readString(message, "from") ??
    "";
  const senderName =
    readString(handle, "displayName") ??
    readString(handle, "name") ??
    readString(message, "senderName") ??
    undefined;

  return { senderId, senderName };
}

function extractChatContext(message: Record<string, unknown>): {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  chatName?: string;
  isGroup: boolean;
  explicitIsGroupHint?: boolean;
  explicitGroupChatHint?: boolean;
  participants: unknown[];
} {
  const chat = asRecord(message.chat) ?? asRecord(message.conversation) ?? null;
  const chatFromList = readFirstChatRecord(message);
  const conversationLabel = extractConversationLabel(message);
  const chatGuidFromConversationLabel = extractChatGuidFromConversationLabel(conversationLabel);
  const chatGuid =
    readString(message, "chatGuid") ??
    readString(message, "chat_guid") ??
    readString(chat, "chatGuid") ??
    readString(chat, "chat_guid") ??
    readString(chat, "guid") ??
    readString(chatFromList, "chatGuid") ??
    readString(chatFromList, "chat_guid") ??
    readString(chatFromList, "guid") ??
    chatGuidFromConversationLabel;
  const chatIdentifier =
    readString(message, "chatIdentifier") ??
    readString(message, "chat_identifier") ??
    readString(chat, "chatIdentifier") ??
    readString(chat, "chat_identifier") ??
    readString(chat, "identifier") ??
    readString(chatFromList, "chatIdentifier") ??
    readString(chatFromList, "chat_identifier") ??
    readString(chatFromList, "identifier") ??
    extractChatIdentifierFromChatGuid(chatGuid);
  const chatId =
    readNumberLike(message, "chatId") ??
    readNumberLike(message, "chat_id") ??
    readNumberLike(chat, "chatId") ??
    readNumberLike(chat, "chat_id") ??
    readNumberLike(chat, "id") ??
    readNumberLike(chatFromList, "chatId") ??
    readNumberLike(chatFromList, "chat_id") ??
    readNumberLike(chatFromList, "id");
  const chatName =
    readString(message, "chatName") ??
    readString(chat, "displayName") ??
    readString(chat, "name") ??
    readString(chatFromList, "displayName") ??
    readString(chatFromList, "name") ??
    undefined;

  const chatParticipants = chat ? chat["participants"] : undefined;
  const messageParticipants = message["participants"];
  const chatsParticipants = chatFromList ? chatFromList["participants"] : undefined;
  const participants = Array.isArray(chatParticipants)
    ? chatParticipants
    : Array.isArray(messageParticipants)
      ? messageParticipants
      : Array.isArray(chatsParticipants)
        ? chatsParticipants
        : [];
  const participantsCount = participants.length;
  const groupFromChatGuid = resolveGroupFlagFromChatGuid(chatGuid);
  const hasConcreteChatIdentity =
    Boolean(chatGuid?.trim()) ||
    Boolean(chatIdentifier?.trim()) ||
    (typeof chatId === "number" && Number.isFinite(chatId));
  const explicitGroupChatHint = readFirstBooleanWithSource([
    { record: message, key: "isGroupChat" },
    { record: message, key: "is_group_chat" },
    { record: message, key: "group" },
    { record: chat, key: "isGroupChat" },
    { record: chat, key: "is_group_chat" },
    { record: chatFromList, key: "isGroupChat" },
    { record: chatFromList, key: "is_group_chat" },
  ]);
  const explicitIsGroupCandidate =
    explicitGroupChatHint ??
    readFirstBooleanWithSource([
      { record: message, key: "isGroup" },
      { record: message, key: "is_group" },
      { record: chat, key: "isGroup" },
      { record: chat, key: "is_group" },
      { record: chatFromList, key: "isGroup" },
      { record: chatFromList, key: "is_group" },
      { record: message, key: "group" },
    ]);
  const explicitIsGroup = !hasConcreteChatIdentity ? undefined : explicitIsGroupCandidate?.value;
  const isGroup =
    typeof groupFromChatGuid === "boolean"
      ? groupFromChatGuid
      : (explicitIsGroup ?? participantsCount > 2);

  return {
    chatGuid,
    chatIdentifier,
    chatId,
    chatName,
    isGroup,
    explicitIsGroupHint: explicitIsGroup,
    explicitGroupChatHint: explicitGroupChatHint?.value,
    participants,
  };
}

function normalizeParticipantEntry(entry: unknown): BlueBubblesParticipant | null {
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
  const nestedHandle =
    asRecord(record["handle"]) ?? asRecord(record["sender"]) ?? asRecord(record["contact"]) ?? null;
  const idRaw =
    readString(record, "address") ??
    readString(record, "handle") ??
    readString(record, "id") ??
    readString(record, "phoneNumber") ??
    readString(record, "phone_number") ??
    readString(record, "email") ??
    readString(nestedHandle, "address") ??
    readString(nestedHandle, "handle") ??
    readString(nestedHandle, "id");
  const nameRaw =
    readString(record, "displayName") ??
    readString(record, "name") ??
    readString(record, "title") ??
    readString(nestedHandle, "displayName") ??
    readString(nestedHandle, "name");
  const normalizedId = idRaw ? normalizeBlueBubblesHandle(idRaw) || idRaw.trim() : "";
  if (!normalizedId) {
    return null;
  }
  const name = nameRaw?.trim() || undefined;
  return { id: normalizedId, name };
}

function normalizeParticipantList(raw: unknown): BlueBubblesParticipant[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const output: BlueBubblesParticipant[] = [];
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

export function formatGroupMembers(params: {
  participants?: BlueBubblesParticipant[];
  fallback?: BlueBubblesParticipant;
}): string | undefined {
  const seen = new Set<string>();
  const ordered: BlueBubblesParticipant[] = [];
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
    return undefined;
  }
  return ordered.map((entry) => (entry.name ? `${entry.name} (${entry.id})` : entry.id)).join(", ");
}

export function resolveGroupFlagFromChatGuid(chatGuid?: string | null): boolean | undefined {
  const guid = chatGuid?.trim();
  if (!guid) {
    return undefined;
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
  return undefined;
}

function extractChatIdentifierFromChatGuid(chatGuid?: string | null): string | undefined {
  const guid = chatGuid?.trim();
  if (!guid) {
    return undefined;
  }
  const parts = guid.split(";");
  if (parts.length < 3) {
    return undefined;
  }
  const identifier = parts[2]?.trim();
  return identifier || undefined;
}

function extractConversationLabel(message: Record<string, unknown>): string | undefined {
  return readString(message, "conversationLabel") ?? readString(message, "conversation_label");
}

function extractChatGuidFromConversationLabel(conversationLabel?: string): string | undefined {
  const label = conversationLabel?.trim();
  if (!label) {
    return undefined;
  }
  const markerIndex = label.toLowerCase().lastIndexOf("id:");
  if (markerIndex < 0) {
    return undefined;
  }
  const chatGuid = label.slice(markerIndex + 3).trim();
  if (!chatGuid) {
    return undefined;
  }
  return resolveGroupFlagFromChatGuid(chatGuid) === true ? chatGuid : undefined;
}

export function formatGroupAllowlistEntry(params: {
  chatGuid?: string;
  chatId?: number;
  chatIdentifier?: string;
}): string | null {
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

export type BlueBubblesParticipant = {
  id: string;
  name?: string;
};

export type NormalizedWebhookMessage = {
  text: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
  attachments?: BlueBubblesAttachment[];
  balloonBundleId?: string;
  associatedMessageGuid?: string;
  associatedMessageType?: number;
  associatedMessageEmoji?: string;
  isTapback?: boolean;
  participants?: BlueBubblesParticipant[];
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  itemType?: number;
  dateEdited?: number;
  explicitIsGroupHint?: boolean;
  explicitGroupChatHint?: boolean;
  explicitWasMentioned?: boolean;
  hasConversationLabel?: boolean;
  hasExplicitGroupChatFlag?: boolean;
  hasMessageIdFull?: boolean;
};

export type NormalizedWebhookReaction = {
  action: "added" | "removed";
  emoji: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
};

const REACTION_TYPE_MAP = new Map<number, { emoji: string; action: "added" | "removed" }>([
  [2000, { emoji: "❤️", action: "added" }],
  [2001, { emoji: "👍", action: "added" }],
  [2002, { emoji: "👎", action: "added" }],
  [2003, { emoji: "😂", action: "added" }],
  [2004, { emoji: "‼️", action: "added" }],
  [2005, { emoji: "❓", action: "added" }],
  [3000, { emoji: "❤️", action: "removed" }],
  [3001, { emoji: "👍", action: "removed" }],
  [3002, { emoji: "👎", action: "removed" }],
  [3003, { emoji: "😂", action: "removed" }],
  [3004, { emoji: "‼️", action: "removed" }],
  [3005, { emoji: "❓", action: "removed" }],
]);

// Maps tapback text patterns (e.g., "Loved", "Liked") to emoji + action
const TAPBACK_TEXT_MAP = new Map<string, { emoji: string; action: "added" | "removed" }>([
  ["loved", { emoji: "❤️", action: "added" }],
  ["liked", { emoji: "👍", action: "added" }],
  ["disliked", { emoji: "👎", action: "added" }],
  ["laughed at", { emoji: "😂", action: "added" }],
  ["emphasized", { emoji: "‼️", action: "added" }],
  ["questioned", { emoji: "❓", action: "added" }],
  // Removal patterns (e.g., "Removed a heart from")
  ["removed a heart from", { emoji: "❤️", action: "removed" }],
  ["removed a like from", { emoji: "👍", action: "removed" }],
  ["removed a dislike from", { emoji: "👎", action: "removed" }],
  ["removed a laugh from", { emoji: "😂", action: "removed" }],
  ["removed an emphasis from", { emoji: "‼️", action: "removed" }],
  ["removed a question from", { emoji: "❓", action: "removed" }],
]);

const TAPBACK_EMOJI_REGEX =
  /(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/u;

function extractFirstEmoji(text: string): string | null {
  const match = text.match(TAPBACK_EMOJI_REGEX);
  return match ? match[0] : null;
}

function extractQuotedTapbackText(text: string): string | null {
  const match = text.match(/[“"]([^”"]+)[”"]/s);
  return match ? match[1] : null;
}

function isTapbackAssociatedType(type: number | undefined): boolean {
  return typeof type === "number" && Number.isFinite(type) && type >= 2000 && type < 4000;
}

function resolveTapbackActionHint(type: number | undefined): "added" | "removed" | undefined {
  if (typeof type !== "number" || !Number.isFinite(type)) {
    return undefined;
  }
  if (type >= 3000 && type < 4000) {
    return "removed";
  }
  if (type >= 2000 && type < 3000) {
    return "added";
  }
  return undefined;
}

export function resolveTapbackContext(message: NormalizedWebhookMessage): {
  emojiHint?: string;
  actionHint?: "added" | "removed";
  replyToId?: string;
} | null {
  const associatedType = message.associatedMessageType;
  const hasTapbackType = isTapbackAssociatedType(associatedType);
  const hasTapbackMarker = Boolean(message.associatedMessageEmoji) || Boolean(message.isTapback);
  if (!hasTapbackType && !hasTapbackMarker) {
    return null;
  }
  const replyToId = message.associatedMessageGuid?.trim() || message.replyToId?.trim() || undefined;
  const actionHint = resolveTapbackActionHint(associatedType);
  const emojiHint =
    message.associatedMessageEmoji?.trim() || REACTION_TYPE_MAP.get(associatedType ?? -1)?.emoji;
  return { emojiHint, actionHint, replyToId };
}

// Detects tapback text patterns like 'Loved "message"' and converts to structured format
export function parseTapbackText(params: {
  text: string;
  emojiHint?: string;
  actionHint?: "added" | "removed";
  requireQuoted?: boolean;
}): {
  emoji: string;
  action: "added" | "removed";
  quotedText: string;
} | null {
  const trimmed = params.text.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) {
    return null;
  }

  for (const [pattern, { emoji, action }] of TAPBACK_TEXT_MAP) {
    if (lower.startsWith(pattern)) {
      // Extract quoted text if present (e.g., 'Loved "hello"' -> "hello")
      const afterPattern = trimmed.slice(pattern.length).trim();
      if (params.requireQuoted) {
        const strictMatch = afterPattern.match(/^[“"](.+)[”"]$/s);
        if (!strictMatch) {
          return null;
        }
        return { emoji, action, quotedText: strictMatch[1] };
      }
      const quotedText =
        extractQuotedTapbackText(afterPattern) ?? extractQuotedTapbackText(trimmed) ?? afterPattern;
      return { emoji, action, quotedText };
    }
  }

  if (lower.startsWith("reacted")) {
    const emoji = extractFirstEmoji(trimmed) ?? params.emojiHint;
    if (!emoji) {
      return null;
    }
    const quotedText = extractQuotedTapbackText(trimmed);
    if (params.requireQuoted && !quotedText) {
      return null;
    }
    const fallback = trimmed.slice("reacted".length).trim();
    return { emoji, action: params.actionHint ?? "added", quotedText: quotedText ?? fallback };
  }

  if (lower.startsWith("removed")) {
    const emoji = extractFirstEmoji(trimmed) ?? params.emojiHint;
    if (!emoji) {
      return null;
    }
    const quotedText = extractQuotedTapbackText(trimmed);
    if (params.requireQuoted && !quotedText) {
      return null;
    }
    const fallback = trimmed.slice("removed".length).trim();
    return { emoji, action: params.actionHint ?? "removed", quotedText: quotedText ?? fallback };
  }
  return null;
}

function extractMessagePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const parseRecord = (value: unknown): Record<string, unknown> | null => {
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

export function normalizeWebhookMessage(
  payload: Record<string, unknown>,
): NormalizedWebhookMessage | null {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }

  const text =
    readString(message, "text") ??
    readString(message, "body") ??
    readString(message, "subject") ??
    "";

  const { senderId, senderName } = extractSenderInfo(message);
  const {
    chatGuid,
    chatIdentifier,
    chatId,
    chatName,
    isGroup,
    explicitIsGroupHint,
    explicitGroupChatHint,
    participants,
  } = extractChatContext(message);
  const normalizedParticipants = normalizeParticipantList(participants);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const messageId =
    readString(message, "guid") ??
    readString(message, "id") ??
    readString(message, "messageId") ??
    undefined;
  const balloonBundleId = readString(message, "balloonBundleId");
  const associatedMessageGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId") ??
    undefined;
  const associatedMessageType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  const associatedMessageEmoji =
    readString(message, "associatedMessageEmoji") ??
    readString(message, "associated_message_emoji") ??
    readString(message, "reactionEmoji") ??
    readString(message, "reaction_emoji") ??
    undefined;
  const isTapback =
    readBoolean(message, "isTapback") ??
    readBoolean(message, "is_tapback") ??
    readBoolean(message, "tapback") ??
    undefined;

  const timestampRaw =
    readNumber(message, "date") ??
    readNumber(message, "dateCreated") ??
    readNumber(message, "timestamp");
  const itemType =
    readNumberLike(message, "itemType") ?? readNumberLike(message, "item_type") ?? undefined;
  const dateEdited =
    readNumberLike(message, "dateEdited") ?? readNumberLike(message, "date_edited") ?? undefined;
  const explicitWasMentioned =
    readBoolean(message, "wasMentioned") ?? readBoolean(message, "was_mentioned");
  const hasConversationLabel =
    hasDefinedProperty(message, "conversationLabel") ||
    hasDefinedProperty(message, "conversation_label");
  const hasExplicitGroupChatFlag =
    hasDefinedProperty(message, "isGroupChat") ||
    hasDefinedProperty(message, "is_group_chat") ||
    hasDefinedProperty(message, "isGroup") ||
    hasDefinedProperty(message, "is_group") ||
    hasDefinedProperty(message, "group");
  const hasMessageIdFull =
    hasDefinedProperty(message, "messageIdFull") || hasDefinedProperty(message, "message_id_full");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  // BlueBubbles may omit `handle` in webhook payloads; for DM chat GUIDs we can still infer sender.
  const senderFallbackFromChatGuid =
    !senderId && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }
  const replyMetadata = extractReplyMetadata(message);

  return {
    text,
    senderId: normalizedSender,
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
    replyToSender: replyMetadata.replyToSender,
    itemType,
    dateEdited,
    explicitIsGroupHint,
    explicitGroupChatHint,
    explicitWasMentioned,
    hasConversationLabel,
    hasExplicitGroupChatFlag,
    hasMessageIdFull,
  };
}

export function normalizeWebhookReaction(
  payload: Record<string, unknown>,
): NormalizedWebhookReaction | null {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }

  const associatedGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId") ??
    readString(message, "associated_message_id");
  const associatedType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  if (!associatedGuid || associatedType === undefined) {
    return null;
  }

  const mapping = REACTION_TYPE_MAP.get(associatedType);
  const associatedEmoji =
    readString(message, "associatedMessageEmoji") ??
    readString(message, "associated_message_emoji") ??
    readString(message, "reactionEmoji") ??
    readString(message, "reaction_emoji");
  const emoji = (associatedEmoji?.trim() || mapping?.emoji) ?? `reaction:${associatedType}`;
  const action = mapping?.action ?? resolveTapbackActionHint(associatedType) ?? "added";

  const { senderId, senderName } = extractSenderInfo(message);
  const { chatGuid, chatIdentifier, chatId, chatName, isGroup } = extractChatContext(message);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const timestampRaw =
    readNumberLike(message, "date") ??
    readNumberLike(message, "dateCreated") ??
    readNumberLike(message, "timestamp");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  const senderFallbackFromChatGuid =
    !senderId && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }

  return {
    action,
    emoji,
    senderId: normalizedSender,
    senderName,
    messageId: associatedGuid,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
  };
}
