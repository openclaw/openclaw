// Feishu plugin module implements bot content behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

// Whitelisted text-bearing card element tags. Restricting to these keeps button
// values, action payloads, and other non-display `content` fields out of the
// extracted text.
const FEISHU_CARD_TEXT_TAGS = new Set(["div", "markdown", "lark_md", "plain_text"]);

function normalizeCardTemplateVariable(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readCardTemplateVariables(card: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  for (const source of [card.template_variable, card.template_variables]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeCardTemplateVariable(value);
      if (normalized !== undefined) {
        variables.set(key, normalized);
      }
    }
  }
  return variables;
}

function applyCardTemplateVariables(text: string, variables: Map<string, string>): string {
  if (variables.size === 0) {
    return text;
  }
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
    const variableName = typeof a === "string" ? a : b;
    return variables.get(variableName) ?? match;
  });
}

// Pull the display string off a single leaf element (div text, markdown, plain
// text). Returns undefined for structural/non-text nodes so the walker keeps
// descending instead of treating them as leaves.
function readCardElementText(record: Record<string, unknown>): string | undefined {
  const tag = typeof record.tag === "string" ? record.tag : "";
  if (!FEISHU_CARD_TEXT_TAGS.has(tag)) {
    return undefined;
  }
  if (tag === "div") {
    const text = isRecord(record.text) ? record.text : undefined;
    return typeof text?.content === "string" ? text.content : undefined;
  }
  return typeof record.content === "string" ? record.content : undefined;
}

// Default-locale element arrays, falling back to a single i18n locale so a
// multilingual card does not emit every translation of the same content.
function selectCardElementArrays(card: Record<string, unknown>): unknown[][] {
  const body = isRecord(card.body) ? card.body : undefined;
  const direct: unknown[][] = [];
  for (const candidate of [card.elements, body?.elements]) {
    if (Array.isArray(candidate)) {
      direct.push(candidate);
    }
  }
  if (direct.length > 0) {
    return direct;
  }
  for (const candidate of [card.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const localeElements of Object.values(candidate)) {
      if (Array.isArray(localeElements)) {
        return [localeElements];
      }
    }
  }
  return [];
}

// Interactive card text nests under whitelisted tags at arbitrary depth
// (column_set, table, columns). Walk the header plus default-locale elements,
// resolve template variables, and collect the text so forwarded cards keep
// their content instead of collapsing to a bare `[interactive]` placeholder.
// NOTE: send.ts has a sibling `parseInteractiveCardContent`; these should be
// unified into one shared extractor in a follow-up.
function extractFeishuCardText(card: unknown): string {
  if (!isRecord(card)) {
    return "";
  }
  const variables = readCardTemplateVariables(card);
  const parts: string[] = [];
  const push = (text: string): void => {
    const resolved = applyCardTemplateVariables(text, variables).trim();
    if (resolved) {
      parts.push(resolved);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const text = readCardElementText(node);
    if (text !== undefined) {
      // Leaf text element: stop here so a div is not re-read through its nested
      // `text` node.
      push(text);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(card.header);
  for (const elements of selectCardElementArrays(card)) {
    visit(elements);
  }
  return parts.join("\n");
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
      case "interactive":
        return extractFeishuCardText(parsed) || "[Interactive Card]";
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
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let result = text;
  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const replacement =
      botStripId && mentionId === botStripId
        ? ""
        : mentionId
          ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
          : `@${mention.name}`;
    result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement).trim();
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
