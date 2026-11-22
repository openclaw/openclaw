import {
  parseStrictNonNegativeInteger,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FeishuMessageEvent } from "./event-types.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parseInteractiveCardContent } from "./interactive-message-content.js";
import {
  extractMentionTargets,
  isFeishuBroadcastMention,
  isMentionForwardRequest,
  normalizeMentions,
  type FeishuTextMention,
} from "./mention.js";
import { parsePostContent, renderPostContent } from "./post.js";
import type { FeishuMessageContext } from "./types.js";

type FeishuMessageLike = {
  message: Pick<FeishuMessageEvent["message"], "content" | "message_type" | "mentions">;
};

export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  preparedContent?: string,
): FeishuMessageContext {
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // Preserve mention identities for agent context. Debounced content already expanded
  // each message's own keys, so never reinterpret placeholder-like display names.
  const content =
    preparedContent ??
    normalizeMentions(
      parseMessageContent(event.message.content, event.message.message_type),
      event.message.mentions,
    );
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    replyTargetMessageId: event.message.reply_target_message_id?.trim() || undefined,
    typingTargetMessageId: event.message.typing_target_message_id?.trim() || undefined,
    suppressReplyTarget: event.message.suppress_reply_target === true,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    senderType: event.sender.sender_type === "bot" ? "bot" : "user",
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  const mentionForwardBotOpenId = botOpenId?.trim();
  if (mentionForwardBotOpenId && isMentionForwardRequest(event, mentionForwardBotOpenId)) {
    const mentionTargets = extractMentionTargets(event, mentionForwardBotOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

function parseMessageContent(content: string, messageType: string): string {
  if (messageType === "post") {
    return parsePostContent(content, {
      renderMediaPlaceholders: false,
      emptyTextFallback: "",
    }).textContent;
  }

  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (FEISHU_MEDIA_MESSAGE_TYPES.has(messageType)) {
      return formatFeishuMediaContent(parsed, messageType);
    }
    if (messageType === "share_chat") {
      if (parsed && typeof parsed === "object") {
        // SAFETY: This parsed non-null object is only read through optional unknown-valued fields.
        const share = parsed as { body?: unknown; summary?: unknown; share_chat_id?: unknown };
        const text = normalizeOptionalString(share.body) ?? normalizeOptionalString(share.summary);
        if (text) {
          return text;
        }
        const sharedChatId = normalizeOptionalString(share.share_chat_id);
        if (sharedChatId) {
          return `[Forwarded message: ${sharedChatId}]`;
        }
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      return "[Merged and Forwarded Message - loading...]";
    }
    if (messageType === "interactive") {
      return parseInteractiveCardContent(parsed);
    }
    return content;
  } catch {
    return FEISHU_MEDIA_MESSAGE_TYPES.has(messageType) ? "" : content;
  }
}

const FEISHU_MEDIA_MESSAGE_TYPES = new Set(["image", "file", "audio", "video", "media", "sticker"]);

function checkBotMentioned(event: FeishuMessageLike, botOpenId?: string): boolean {
  if (!botOpenId) {
    return false;
  }
  const mentions = event.message.mentions ?? [];
  if (mentions.length > 0) {
    return mentions.some(
      (mention) => !isFeishuBroadcastMention(mention) && mention.id.open_id === botOpenId,
    );
  }
  if (event.message.message_type === "post") {
    return parsePostContent(event.message.content).mentionedOpenIds.some(
      (id) => id.trim().toLowerCase() !== "all" && id === botOpenId,
    );
  }
  return false;
}

export function normalizeFeishuCommandProbeBody(text: string): string {
  // Real Feishu mentions are normalized to <at> transport markup before this probe.
  // Plain @name text is user content, not addressing that may expose a command.
  const body = text.replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ").trim();
  // Multiline command arguments must survive mention removal before core dispatch.
  return body.startsWith("/") && /[\r\n]/.test(body) ? body : body.replace(/\s+/g, " ");
}

function formatFeishuMediaContent(parsed: Record<string, unknown>, messageType: string): string {
  if (messageType === "sticker") {
    const fileKey = normalizeFeishuExternalKey(parsed?.file_key);
    return fileKey ? `<sticker key="${escapeHtml(fileKey)}"/>` : "[Sticker]";
  }
  const speechToText =
    messageType === "audio" && typeof parsed.speech_to_text === "string"
      ? parsed.speech_to_text.trim()
      : "";
  if (speechToText) {
    return speechToText;
  }
  return "";
}

function formatSubMessageContent(
  content: string,
  contentType: string,
  mentions?: ReadonlyArray<FeishuTextMention>,
): string {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return normalizeMentions(parsed.text || content, mentions);
      case "post":
        return renderPostContent(parsed).textContent;
      case "interactive":
        return parseInteractiveCardContent(parsed);
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return formatFeishuMediaContent(parsed, contentType);
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}

export async function parseMergeForwardContent(
  items: ReadonlyArray<{
    msg_type?: string;
    body?: { content?: string };
    upper_message_id?: string;
    create_time?: string;
    sender?: { id?: string };
    mentions?: ReadonlyArray<FeishuTextMention>;
  }>,
  resolveSenderName?: (senderId: string) => Promise<string | undefined>,
): Promise<string> {
  const maxMessages = 50;
  if (items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }
  const container = items.find(
    (item) => item.msg_type === "merge_forward" && !item.upper_message_id,
  );
  const subMessages = container
    ? items.filter((item) => item !== container)
    : items.filter((item) => item.upper_message_id);
  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }
  subMessages.sort(
    (a, b) =>
      (parseStrictNonNegativeInteger(a.create_time) ?? 0) -
      (parseStrictNonNegativeInteger(b.create_time) ?? 0),
  );

  const lines = ["[Merged and Forwarded Messages]"];
  const senderNames = new Map<string, string>();
  for (const item of subMessages.slice(0, maxMessages)) {
    const body = formatSubMessageContent(
      item.body?.content || "",
      item.msg_type || "text",
      item.mentions,
    );
    const ms = parseStrictNonNegativeInteger(item.create_time);
    const timestamp = ms === undefined ? undefined : timestampMsToIsoString(ms);
    const senderId = item.sender?.id;
    if (senderId && resolveSenderName && !senderNames.has(senderId)) {
      senderNames.set(senderId, (await resolveSenderName(senderId)) ?? senderId);
    }
    const sender = senderId ? (senderNames.get(senderId) ?? senderId) : undefined;
    lines.push(`- ${timestamp ? `[${timestamp}] ` : ""}${sender ? `${sender}: ` : ""}${body}`);
  }
  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }
  const rendered = lines.join("\n");
  const maxContentChars = 20_000;
  const marker = "\n... [Merged-forward content truncated]";
  return rendered.length <= maxContentChars
    ? rendered
    : `${truncateUtf16Safe(rendered, maxContentChars - marker.length).trimEnd()}${marker}`;
}
