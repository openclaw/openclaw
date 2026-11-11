import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  buildFeishuConversationId,
  resolveConfiguredFeishuGroupSessionScope,
} from "./conversation-id.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parseInteractiveCardContent } from "./interactive-message-content.js";
import { saveMessageResourceFeishu } from "./media.js";
import {
  extractMentionTargets,
  isFeishuBroadcastMention,
  isMentionForwardRequest,
  normalizeMentions,
} from "./mention.js";
import { formatFeishuMediaContent } from "./message-content.js";
import { parsePostContent } from "./post.js";
import type {
  FeishuChatType,
  FeishuConfig,
  FeishuMediaInfo,
  FeishuMessageContext,
} from "./types.js";

type FeishuMessageLike = {
  message: Pick<FeishuMessageEvent["message"], "content" | "message_type" | "mentions">;
};

type FeishuGroupSessionConfig = Pick<
  FeishuConfig,
  "groupSessionScope" | "topicSessionMode" | "replyInThread"
>;

export function resolveFeishuGroupSession(params: {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  chatType?: FeishuChatType;
  groupConfig?: FeishuGroupSessionConfig;
  feishuCfg?: FeishuGroupSessionConfig;
}) {
  const { chatId, senderOpenId, messageId, rootId, threadId, chatType, groupConfig, feishuCfg } =
    params;
  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread =
    (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" ||
    threadReply;
  const groupSessionScope = resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg });
  const normalizedTopicGroupThreadId =
    chatType === "topic_group" ? (normalizedThreadId ?? normalizedRootId) : undefined;
  const topicScope =
    groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender"
      ? (normalizedTopicGroupThreadId ??
        normalizedRootId ??
        normalizedThreadId ??
        (replyInThread ? messageId : null))
      : null;

  const peerId =
    groupSessionScope === "group_sender" || groupSessionScope === "group_topic_sender" || topicScope
      ? buildFeishuConversationId({
          chatId,
          scope: groupSessionScope,
          senderOpenId,
          topicId: topicScope ?? undefined,
        })
      : chatId;

  return {
    peerId,
    parentPeer: topicScope ? { kind: "group" as const, id: chatId } : null,
    groupSessionScope,
    replyInThread,
    threadReply,
  };
}

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
  const body = text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/(^|\s)@[^/\s]+(?=\s|$|\/)/gu, "$1")
    .trim();
  // Multiline command arguments must survive mention removal before core dispatch.
  return body.startsWith("/") && /[\r\n]/.test(body) ? body : body.replace(/\s+/g, " ");
}

function parseMediaResource(
  content: string,
  messageType: string,
): { key?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    const key =
      messageType === "image"
        ? imageKey
        : messageType === "video" || messageType === "media"
          ? fileKey || imageKey
          : fileKey;
    return { key, fileName: parsed.file_name };
  } catch {
    return {};
  }
}

function resolveFeishuMediaKind(messageType: string): FeishuMediaInfo["kind"] {
  switch (messageType) {
    case "image":
      return "image";
    case "file":
      return "document";
    case "audio":
      return "audio";
    case "video":
    case "media":
      return "video";
    default:
      return "document";
  }
}

export async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;
  // Sticker keys are reusable, but Feishu does not expose their resource bytes.
  const mediaTypes = ["image", "file", "audio", "video", "media", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const resources: Array<{
    key: string;
    type: "image" | "file";
    fileName?: string;
    kind: FeishuMediaInfo["kind"];
    label: string;
  }> = [];
  if (messageType === "post") {
    const { attachments } = parsePostContent(content);
    if (attachments.length === 0) {
      return [];
    }
    log?.(`feishu: post message contains ${attachments.length} embedded attachment(s)`);
    const seenAttachments = new Set<string>();
    for (const attachment of attachments) {
      const identity = `${attachment.kind}:${attachment.key}`;
      if (seenAttachments.has(identity)) {
        continue;
      }
      seenAttachments.add(identity);
      resources.push({
        key: attachment.key,
        type: attachment.kind,
        fileName: attachment.kind === "file" ? attachment.fileName : undefined,
        kind:
          attachment.kind === "image"
            ? "image"
            : attachment.origin === "top-level"
              ? "document"
              : "video",
        label: `embedded ${attachment.kind} ${attachment.key}`,
      });
    }
  } else {
    const resource = parseMediaResource(content, messageType);
    if (!resource.key) {
      return [{ kind: resolveFeishuMediaKind(messageType) }];
    }
    resources.push({
      key: resource.key,
      type: messageType === "image" ? "image" : "file",
      fileName: resource.fileName,
      kind: resolveFeishuMediaKind(messageType),
      label: `${messageType} media`,
    });
  }

  const out: FeishuMediaInfo[] = [];
  for (const resource of resources) {
    try {
      const saved = await saveMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: resource.key,
        type: resource.type,
        accountId,
        maxBytes,
        originalFilename: resource.fileName,
      });
      out.push({ path: saved.path, contentType: saved.contentType, kind: resource.kind });
      log?.(`feishu: downloaded ${resource.label}, saved to ${saved.path}`);
    } catch (err) {
      out.push({ kind: resource.kind });
      log?.(`feishu: failed to download ${resource.label}: ${String(err)}`);
    }
  }
  return out;
}
