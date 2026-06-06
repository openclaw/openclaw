// Feishu plugin module implements bot content behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { buildFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { saveMessageResourceFeishu } from "./media.js";
import { isFeishuBroadcastMention } from "./mention.js";
import { parsePostContent } from "./post.js";
import { getFeishuRuntime } from "./runtime.js";
import type { FeishuChatType, FeishuMediaInfo } from "./types.js";

type FeishuMention = {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name: string;
  tenant_key?: string;
};

type FeishuMessageLike = {
  message: {
    content: string;
    message_type: string;
    mentions?: FeishuMention[];
    chat_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    message_id: string;
  };
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
    };
  };
};

type GroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

type FeishuLogger = (...args: unknown[]) => void;

type ResolvedFeishuGroupSession = {
  peerId: string;
  parentPeer: { kind: "group"; id: string } | null;
  groupSessionScope: GroupSessionScope;
  replyInThread: boolean;
  threadReply: boolean;
};

export function resolveFeishuGroupSession(params: {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  chatType?: FeishuChatType;
  groupConfig?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
  feishuCfg?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
}): ResolvedFeishuGroupSession {
  const { chatId, senderOpenId, messageId, rootId, threadId, chatType, groupConfig, feishuCfg } =
    params;
  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread =
    (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" ||
    threadReply;
  const legacyTopicSessionMode =
    groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
  const groupSessionScope: GroupSessionScope =
    groupConfig?.groupSessionScope ??
    feishuCfg?.groupSessionScope ??
    (legacyTopicSessionMode === "enabled" ? "group_topic" : "group");
  const normalizedTopicGroupThreadId =
    chatType === "topic_group" ? (normalizedThreadId ?? normalizedRootId) : undefined;
  const topicScope =
    groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender"
      ? (normalizedTopicGroupThreadId ??
        normalizedRootId ??
        normalizedThreadId ??
        (replyInThread ? messageId : null))
      : null;

  let peerId;
  switch (groupSessionScope) {
    case "group_sender":
      peerId = buildFeishuConversationId({ chatId, scope: "group_sender", senderOpenId });
      break;
    case "group_topic":
      peerId = topicScope
        ? buildFeishuConversationId({ chatId, scope: "group_topic", topicId: topicScope })
        : chatId;
      break;
    case "group_topic_sender":
      peerId = topicScope
        ? buildFeishuConversationId({
            chatId,
            scope: "group_topic_sender",
            topicId: topicScope,
            senderOpenId,
          })
        : buildFeishuConversationId({ chatId, scope: "group_sender", senderOpenId });
      break;
    default:
      peerId = chatId;
      break;
  }

  return {
    peerId,
    parentPeer:
      topicScope &&
      (groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender")
        ? { kind: "group", id: chatId }
        : null,
    groupSessionScope,
    replyInThread,
    threadReply,
  };
}

export type FeishuReplyRouting = {
  /** Message id to reply to; undefined means a top-level send. */
  replyTargetMessageId?: string;
  /** root_id handed to the dispatcher for streaming-card thread routing. */
  dispatchRootId?: string;
  /** reply_in_thread flag handed to the dispatcher. */
  dispatchReplyInThread: boolean;
  /** threadReply flag handed to the dispatcher. */
  threadReply: boolean;
};

/**
 * Decide where a reply lands. Bot-to-bot replies in a normal group stay as
 * inline quote replies but never thread: otherwise auto-detected threadReply (a
 * root_id on an inbound bot reply) snowballs a bot conversation into a Feishu
 * topic hidden from the main chat view (#32980). The quote/reply target is kept
 * so the reply still shows which message it answers and the typing reaction
 * still attaches — only the thread flags are forced off. Explicit topic-session
 * scope or replyInThread=enabled config still wins and keeps the reply threaded.
 *
 * ctx.rootId is intentionally left untouched by callers for thread-history
 * fetching; this only strips what the dispatcher uses to route the outgoing
 * message into a thread.
 */
export function resolveFeishuReplyRouting(params: {
  isGroup: boolean;
  senderType: "user" | "bot";
  isTopicSession: boolean;
  configReplyInThread: boolean;
  messageId: string;
  rootId?: string;
  replyTargetMessageId?: string;
  suppressReplyTarget?: boolean;
  /** groupSession.threadReply (auto-detected from root_id/thread_id). */
  groupThreadReply: boolean;
  /** groupSession.replyInThread (config-enabled OR auto threadReply). */
  groupReplyInThread: boolean;
}): FeishuReplyRouting {
  const { isGroup, isTopicSession, configReplyInThread } = params;
  const fallbackTarget = params.suppressReplyTarget ? undefined : params.messageId;
  const suppressForBotPeer =
    isGroup && params.senderType === "bot" && !isTopicSession && !configReplyInThread;

  if (suppressForBotPeer) {
    // Keep the quote/reply target (inline quote + typing reaction); only force
    // the thread flags off so the exchange stays in the main timeline.
    return {
      replyTargetMessageId: params.replyTargetMessageId ?? fallbackTarget,
      dispatchRootId: undefined,
      dispatchReplyInThread: false,
      threadReply: false,
    };
  }

  const replyTargetMessageId =
    isTopicSession || configReplyInThread
      ? (params.rootId ?? params.replyTargetMessageId ?? fallbackTarget)
      : (params.replyTargetMessageId ?? fallbackTarget);
  return {
    replyTargetMessageId,
    dispatchRootId: params.rootId,
    dispatchReplyInThread: isGroup ? params.groupReplyInThread : false,
    threadReply: isGroup ? params.groupThreadReply : false,
  };
}

export function parseMessageContent(content: string, messageType: string): string {
  if (messageType === "post") {
    return parsePostContent(content).textContent;
  }

  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (["image", "file", "audio", "video", "media", "sticker"].includes(messageType)) {
      if (messageType === "audio") {
        const speechToText =
          typeof parsed.speech_to_text === "string" ? parsed.speech_to_text.trim() : "";
        if (speechToText) {
          return speechToText;
        }
      }
      const placeholder = inferPlaceholder(messageType);
      const fileName = typeof parsed.file_name === "string" ? parsed.file_name.trim() : "";
      return fileName ? `${placeholder} (${fileName})` : placeholder;
    }
    if (messageType === "share_chat") {
      if (parsed && typeof parsed === "object") {
        const share = parsed as { body?: unknown; summary?: unknown; share_chat_id?: unknown };
        if (typeof share.body === "string" && share.body.trim()) {
          return share.body.trim();
        }
        if (typeof share.summary === "string" && share.summary.trim()) {
          return share.summary.trim();
        }
        if (typeof share.share_chat_id === "string" && share.share_chat_id.trim()) {
          return `[Forwarded message: ${share.share_chat_id.trim()}]`;
        }
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      return "[Merged and Forwarded Message - loading...]";
    }
    return content;
  } catch {
    return content;
  }
}

function formatSubMessageContent(content: string, contentType: string): string {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return parsed.text || content;
      case "post":
        return parsePostContent(content).textContent;
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return "[Sticker]";
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}

export function parseMergeForwardContent(params: { content: string; log?: FeishuLogger }): string {
  const { content, log } = params;
  const maxMessages = 50;
  log?.("feishu: parsing merge_forward sub-messages from API response");

  let items: Array<{
    message_id?: string;
    msg_type?: string;
    body?: { content?: string };
    sender?: { id?: string };
    upper_message_id?: string;
    create_time?: string;
  }>;
  try {
    items = JSON.parse(content);
  } catch {
    log?.("feishu: merge_forward items parse failed");
    return "[Merged and Forwarded Message - parse error]";
  }
  if (!Array.isArray(items) || items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }
  const subMessages = items.filter((item) => item.upper_message_id);
  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }

  log?.(`feishu: merge_forward contains ${subMessages.length} sub-messages`);
  subMessages.sort(
    (a, b) =>
      (parseStrictNonNegativeInteger(a.create_time) ?? 0) -
      (parseStrictNonNegativeInteger(b.create_time) ?? 0),
  );

  const lines = ["[Merged and Forwarded Messages]"];
  for (const item of subMessages.slice(0, maxMessages)) {
    lines.push(`- ${formatSubMessageContent(item.body?.content || "", item.msg_type || "text")}`);
  }
  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }
  return lines.join("\n");
}

export function checkBotMentioned(event: FeishuMessageLike, botOpenId?: string): boolean {
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

export function normalizeMentions(
  text: string,
  mentions?: FeishuMention[],
  botStripId?: string,
): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }
  const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Only strip the leading self-mention (the "addressing" mention at text start).
  // Non-leading self-mentions carry semantic meaning and are preserved as <at> tags.
  const leadingSelfKey = botStripId
    ? mentions.find((m) => m.id.open_id === botStripId && text.trimStart().startsWith(m.key))?.key
    : undefined;

  let result = text;
  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const atTag = mentionId
      ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
      : `@${mention.name}`;
    if (mention.key === leadingSelfKey) {
      // Strip only the first (leading) occurrence; convert any remaining same-key
      // occurrences to <at> tags so non-leading self-mentions are preserved.
      result = result.replace(mention.key, "").trim();
      result = result.replace(new RegExp(esc(mention.key), "g"), () => atTag).trim();
    } else {
      result = result.replace(new RegExp(esc(mention.key), "g"), () => atTag).trim();
    }
  }
  return result;
}

export function normalizeFeishuCommandProbeBody(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/(^|\s)@[^/\s]+(?=\s|$|\/)/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey, fileName: parsed.file_name };
      case "file":
      case "audio":
      case "sticker":
        return { fileKey, fileName: parsed.file_name };
      case "video":
      case "media":
        return { fileKey, imageKey, fileName: parsed.file_name };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

export function toMessageResourceType(messageType: string): "image" | "file" {
  return messageType === "image" ? "image" : "file";
}

async function resolveSavedFeishuMedia(params: {
  result:
    | Awaited<ReturnType<typeof saveMessageResourceFeishu>>
    | { buffer: Buffer; contentType?: string; fileName?: string };
  maxBytes: number;
  originalFilename?: string;
}) {
  if ("saved" in params.result) {
    return params.result.saved;
  }
  const core = getFeishuRuntime();
  const contentType =
    params.result.contentType ?? (await core.media.detectMime({ buffer: params.result.buffer }));
  return await core.channel.media.saveMediaBuffer(
    params.result.buffer,
    contentType,
    "inbound",
    params.maxBytes,
    params.result.fileName ?? params.originalFilename,
  );
}

function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
    case "media":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
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
  const mediaTypes = ["image", "file", "audio", "video", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  if (messageType === "post") {
    const { imageKeys, mediaKeys } = parsePostContent(content);
    if (imageKeys.length === 0 && mediaKeys.length === 0) {
      return [];
    }
    if (imageKeys.length > 0) {
      log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);
    }
    if (mediaKeys.length > 0) {
      log?.(`feishu: post message contains ${mediaKeys.length} embedded media file(s)`);
    }

    for (const imageKey of imageKeys) {
      try {
        const result = await saveMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId,
          maxBytes,
        });
        const saved = await resolveSavedFeishuMedia({ result, maxBytes });
        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });
        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    for (const media of mediaKeys) {
      try {
        const result = await saveMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: media.fileKey,
          type: "file",
          accountId,
          maxBytes,
          originalFilename: media.fileName,
        });
        const saved = await resolveSavedFeishuMedia({
          result,
          maxBytes,
          originalFilename: media.fileName,
        });
        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:video>",
        });
        log?.(`feishu: downloaded embedded media ${media.fileKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded media ${media.fileKey}: ${String(err)}`);
      }
    }
    return out;
  }

  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    const fileKey = mediaKeys.fileKey || mediaKeys.imageKey;
    if (!fileKey) {
      return [];
    }
    const result = await saveMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: toMessageResourceType(messageType),
      accountId,
      maxBytes,
      originalFilename: mediaKeys.fileName,
    });
    const saved = await resolveSavedFeishuMedia({
      result,
      maxBytes,
      originalFilename: mediaKeys.fileName,
    });
    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });
    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }
  return out;
}
