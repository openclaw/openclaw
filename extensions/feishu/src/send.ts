import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
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
  return toFeishuSendResult(response, params.receiveId);
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

/**
 * Extract readable text from an array of Feishu card elements.
 * Handles div, markdown, column_set, and nested elements (form, collapsible).
 *
 * This is the leaf-level extractor used by {@link parseInteractiveCardContent}.
 */
function extractTextsFromElements(elements: unknown[]): string[] {
  const texts: string[] = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }
    const item = element as {
      tag?: string;
      content?: string;
      text?: { content?: string };
      columns?: unknown[];
      elements?: unknown[];
    };
    if (item.tag === "div" && typeof item.text?.content === "string") {
      texts.push(item.text.content);
      continue;
    }
    if (item.tag === "markdown" && typeof item.content === "string") {
      texts.push(item.content);
      continue;
    }
    // column_set → recurse into each column's elements
    if (item.tag === "column_set" && Array.isArray(item.columns)) {
      for (const col of item.columns) {
        if (
          col &&
          typeof col === "object" &&
          Array.isArray((col as { elements?: unknown[] }).elements)
        ) {
          texts.push(...extractTextsFromElements((col as { elements: unknown[] }).elements));
        }
      }
      continue;
    }
    // Generic nested elements (e.g. form, collapsible)
    if (Array.isArray(item.elements)) {
      texts.push(...extractTextsFromElements(item.elements));
    }
  }
  return texts;
}

/**
 * Parse interactive card (message_type=interactive) into readable text.
 *
 * Data flow for quoted messages:
 *   event webhook → parentId → getMessageFeishu (API fetch) →
 *   parseQuotedMessageContent → parseInteractiveCardContent
 *
 * Data flow for direct interactive messages:
 *   event webhook → parseMessageContent (bot.ts) → parseInteractiveCardContent
 *
 * Feishu interactive cards come in several shapes:
 * 1. Flat v1: `{ "elements": [...] }`
 * 2. With header: `{ "header": { "title": { "content": "..." } }, "elements": [...] }`
 * 3. Body wrapper (card kit v2 / schema 2.0): `{ "body": { "elements": [...] } }`
 * 4. i18n: `{ "i18n_elements": { "zh_cn": [...] } }`
 * 5. Template: `{ "type": "template", "data": { "template_variable": {...} } }`
 * 6. Streaming card ref: `{ "type": "card", "data": { "card_id": "..." } }`
 *    — card_id references point to a server-side card; content may not be inline.
 *      We still attempt to extract header/elements if present before falling back.
 */
export function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const card = parsed as {
    header?: { title?: { content?: string } };
    elements?: unknown[];
    i18n_elements?: { zh_cn?: unknown[]; [locale: string]: unknown[] | undefined };
    body?: { elements?: unknown[] };
    type?: string;
    data?: { template_variable?: Record<string, unknown>; card_id?: string };
  };

  const texts: string[] = [];

  // Extract header title if present
  if (typeof card.header?.title?.content === "string" && card.header.title.content.trim()) {
    texts.push(card.header.title.content);
  }

  // Resolve the elements array from multiple possible locations
  let elements: unknown[] | undefined = card.elements;
  if (!Array.isArray(elements)) {
    // Try body.elements (card kit v2 / schema 2.0)
    elements = card.body?.elements;
  }
  if (!Array.isArray(elements)) {
    // Try i18n_elements — pick zh_cn first (if non-empty array), then first available locale
    if (card.i18n_elements && typeof card.i18n_elements === "object") {
      const zhCn = card.i18n_elements.zh_cn;
      elements =
        (Array.isArray(zhCn) && zhCn.length > 0 ? zhCn : undefined) ??
        (Object.values(card.i18n_elements).find((v) => Array.isArray(v) && v.length > 0) as
          | unknown[]
          | undefined);
    }
  }

  if (Array.isArray(elements)) {
    texts.push(...extractTextsFromElements(elements));
  }

  // Template cards: extract template_variable values as last resort
  if (texts.length === 0 && card.type === "template" && card.data?.template_variable) {
    const vars = card.data.template_variable;
    for (const val of Object.values(vars)) {
      if (typeof val === "string" && val.trim()) {
        texts.push(val);
      }
    }
  }

  // Streaming card reference — only use placeholder when no content was extracted
  if (texts.length === 0 && card.type === "card" && card.data?.card_id) {
    return "[Streaming Card]";
  }

  return texts.join("\n").trim() || "[Interactive Card]";
}

/**
 * Parse the raw content string of a quoted (replied-to) Feishu message.
 *
 * Called by {@link getMessageFeishu} after fetching the original message via API.
 * For interactive cards, delegates to {@link parseInteractiveCardContent}.
 */
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
    const content = parseQuotedMessageContent(rawContent, msgType);

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
      return sendFallbackDirect(client, directParams, "Feishu send failed");
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu send failed");
    }
    assertFeishuMessageApiSuccess(response, "Feishu reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  return sendFallbackDirect(client, directParams, "Feishu send failed");
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, accountId } = params;
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
      return sendFallbackDirect(client, directParams, "Feishu card send failed");
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu card send failed");
    }
    assertFeishuMessageApiSuccess(response, "Feishu card reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  return sendFallbackDirect(client, directParams, "Feishu card send failed");
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
  const content = JSON.stringify(card);

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
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, replyInThread, accountId });
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
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);

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
