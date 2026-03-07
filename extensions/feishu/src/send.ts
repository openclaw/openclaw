import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import {
  buildMentionedMessage,
  buildMentionedCardContent,
  normalizeMentionTagsForCard,
  normalizeMentionTagsForText,
} from "./mention.js";
import { parsePostContent } from "./post.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import type { FeishuSendResult } from "./types.js";

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);

function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true;
  }
  const msg = response.msg?.toLowerCase() ?? "";
  return msg.includes("withdrawn") || msg.includes("not found");
}

/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  // SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true;
  }
  // AxiosError shape: err.response.data.code
  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response;
  if (
    typeof response?.data?.code === "number" &&
    WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)
  ) {
    return true;
  }
  return false;
}

type FeishuCreateMessageClient = {
  im: {
    message: {
      create: (opts: {
        params: { receive_id_type: "chat_id" | "email" | "open_id" | "union_id" | "user_id" };
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    receiveId: string;
    receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
    content: string;
    msgType: string;
  },
  errorPrefix: string,
  mentionMeta?: Record<string, unknown>,
): Promise<FeishuSendResult> {
  const response = await client.im.message.create({
    params: { receive_id_type: params.receiveIdType },
    data: {
      receive_id: params.receiveId,
      content: params.content,
      msg_type: params.msgType,
    },
  });
  assertFeishuMessageApiSuccess(response, errorPrefix);
  return {
    ...toFeishuSendResult(response, params.receiveId),
    ...(mentionMeta ? { meta: mentionMeta } : {}),
  };
}

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const candidate = parsed as { elements?: unknown };
  if (!Array.isArray(candidate.elements)) {
    return "[Interactive Card]";
  }

  const texts: string[] = [];
  for (const element of candidate.elements) {
    if (!element || typeof element !== "object") {
      continue;
    }
    const item = element as {
      tag?: string;
      content?: string;
      text?: { content?: string };
    };
    if (item.tag === "div" && typeof item.text?.content === "string") {
      texts.push(item.text.content);
      continue;
    }
    if (item.tag === "markdown" && typeof item.content === "string") {
      texts.push(item.content);
    }
  }
  return texts.join("\n").trim() || "[Interactive Card]";
}

function parseQuotedMessageContent(rawContent: string, msgType: string): string {
  if (!rawContent) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "[Text message]";
  }

  if (msgType === "post") {
    return parsePostContent(rawContent).textContent;
  }

  if (msgType === "interactive") {
    return parseInteractiveCardContent(parsed);
  }

  if (typeof parsed === "string") {
    return parsed;
  }

  const genericText = (parsed as { text?: unknown; title?: unknown } | null)?.text;
  if (typeof genericText === "string" && genericText.trim()) {
    return genericText;
  }
  const genericTitle = (parsed as { title?: unknown } | null)?.title;
  if (typeof genericTitle === "string" && genericTitle.trim()) {
    return genericTitle;
  }

  return `[${msgType || "unknown"} message]`;
}

/**
 * Replace `@_user_N` placeholders with `@name` using the mentions array
 * returned by the Feishu message API.
 */
export function enrichMentionPlaceholders(
  content: string,
  mentions?: Array<{ key?: string; name?: string }>,
): string {
  if (!mentions || mentions.length === 0) return content;

  const entries: Array<[string, string]> = [];
  for (const m of mentions) {
    const key = m.key?.trim();
    const name = m.name?.trim();
    if (key && name) entries.push([key, `@${name}`]);
  }
  if (entries.length === 0) return content;

  // Sort by key length descending to prevent @_user_1 matching @_user_10
  entries.sort((a, b) => b[0].length - a[0].length);

  const pattern = entries.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const map = new Map(entries);
  return content.replace(new RegExp(pattern, "g"), (match) => map.get(match) ?? match);
}

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.get({
      path: { message_id: messageId },
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
          body?: { content?: string };
          sender?: {
            id?: string;
            id_type?: string;
            sender_type?: string;
          };
          mentions?: Array<{
            key?: string;
            name?: string;
            id?: { open_id?: string; user_id?: string; union_id?: string };
          }>;
          create_time?: string;
        }>;
        message_id?: string;
        chat_id?: string;
        msg_type?: string;
        body?: { content?: string };
        sender?: {
          id?: string;
          id_type?: string;
          sender_type?: string;
        };
        create_time?: string;
      };
    };

    if (response.code !== 0) {
      return null;
    }

    // Support both list shape (data.items[0]) and single-object shape (data as message)
    const rawItem = response.data?.items?.[0] ?? response.data;
    const item =
      rawItem &&
      (rawItem.body !== undefined || (rawItem as { message_id?: string }).message_id !== undefined)
        ? rawItem
        : null;
    if (!item) {
      return null;
    }

    const msgType = item.msg_type ?? "text";
    const rawContent = item.body?.content ?? "";
    const parsedContent = parseQuotedMessageContent(rawContent, msgType);

    const content = enrichMentionPlaceholders(parsedContent, item.mentions);

    return {
      messageId: item.message_id ?? messageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
      senderType: item.sender?.sender_type,
      content,
      contentType: msgType,
      createTime: item.create_time ? parseInt(String(item.create_time), 10) : undefined,
    };
  } catch {
    return null;
  }
}

export type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

function buildMentionMeta(
  mentions?: MentionTarget[],
): { mentions: Array<{ id: string; name?: string }> } | undefined {
  if (!mentions || mentions.length === 0) {
    return undefined;
  }
  return {
    mentions: mentions.map((mention) => ({
      id: mention.openId,
      name: mention.name,
    })),
  };
}

function buildMentionDisplayNameMap(
  mentions?: MentionTarget[],
): Record<string, string> | undefined {
  if (!mentions || mentions.length === 0) {
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const mention of mentions) {
    const openId = mention.openId?.trim();
    if (!openId) {
      continue;
    }
    const name = mention.name?.trim();
    if (name) {
      map[openId] = name;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function normalizeCardMentionTags(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeMentionTagsForCard(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCardMentionTags(item));
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeCardMentionTags(item);
    }
    return normalized;
  }
  return value;
}

function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: messageText,
            },
          ],
        ],
      },
    }),
    msgType: "post",
  };
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
  const mentionMeta = buildMentionMeta(mentions);
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = text ?? "";
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  rawText = normalizeMentionTagsForText(rawText, buildMentionDisplayNameMap(mentions));
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(rawText, tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const directParams = { receiveId, receiveIdType, content, msgType };

  if (replyToMessageId) {
    let response: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: msgType,
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } catch (err) {
      if (!isWithdrawnReplyError(err)) {
        throw err;
      }
      return sendFallbackDirect(client, directParams, "Feishu send failed", mentionMeta);
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu send failed", mentionMeta);
    }
    assertFeishuMessageApiSuccess(response, "Feishu reply failed");
    return {
      ...toFeishuSendResult(response, receiveId),
      ...(mentionMeta ? { meta: mentionMeta } : {}),
    };
  }

  return sendFallbackDirect(client, directParams, "Feishu send failed", mentionMeta);
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  mentions?: MentionTarget[];
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, mentions, accountId } = params;
  const mentionMeta = buildMentionMeta(mentions);
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const content = JSON.stringify(card);

  const directParams = { receiveId, receiveIdType, content, msgType: "interactive" };

  if (replyToMessageId) {
    let response: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: "interactive",
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } catch (err) {
      if (!isWithdrawnReplyError(err)) {
        throw err;
      }
      return sendFallbackDirect(client, directParams, "Feishu card send failed", mentionMeta);
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu card send failed", mentionMeta);
    }
    assertFeishuMessageApiSuccess(response, "Feishu card reply failed");
    return {
      ...toFeishuSendResult(response, receiveId),
      ...(mentionMeta ? { meta: mentionMeta } : {}),
    };
  }

  return sendFallbackDirect(client, directParams, "Feishu card send failed", mentionMeta);
}

export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const content = JSON.stringify(normalizeCardMentionTags(card));

  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };
}

/**
 * Send a message as a markdown card (interactive message).
 * This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  cardText = normalizeMentionTagsForCard(cardText);
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, replyInThread, mentions, accountId });
}

/**
 * Edit an existing text message.
 * Note: Feishu only allows editing messages within 24 hours.
 */
export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, text, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const normalizedText = normalizeMentionTagsForText(text ?? "");
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(
    normalizedText,
    tableMode,
  );

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }
}
