import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { parsePostContent } from "./post.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import type { FeishuChatType, FeishuMessageInfo, FeishuSendResult } from "./types.js";

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
      reply: (opts: {
        path: { message_id: string };
        data: { content: string; msg_type: string; reply_in_thread?: true };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
      create: (opts: {
        params: { receive_id_type: "chat_id" | "email" | "open_id" | "union_id" | "user_id" };
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

type FeishuMessageSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

type FeishuMessageGetItem = {
  message_id?: string;
  chat_id?: string;
  chat_type?: FeishuChatType;
  msg_type?: string;
  body?: { content?: string };
  sender?: FeishuMessageSender;
  create_time?: string;
};

type FeishuGetMessageResponse = {
  code?: number;
  msg?: string;
  data?: FeishuMessageGetItem & {
    items?: FeishuMessageGetItem[];
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

async function sendReplyOrFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    replyToMessageId?: string;
    replyInThread?: boolean;
    content: string;
    msgType: string;
    directParams: {
      receiveId: string;
      receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
      content: string;
      msgType: string;
    };
    directErrorPrefix: string;
    replyErrorPrefix: string;
  },
): Promise<FeishuSendResult> {
  if (!params.replyToMessageId) {
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }

  let response: { code?: number; msg?: string; data?: { message_id?: string } };
  try {
    response = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        content: params.content,
        msg_type: params.msgType,
        ...(params.replyInThread ? { reply_in_thread: true } : {}),
      },
    });
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      throw err;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  if (shouldFallbackFromReplyTarget(response)) {
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
  return toFeishuSendResult(response, params.directParams.receiveId);
}

const CARD_MAX_NODES = 500;
const CARD_MAX_OUTPUT_CHARS = 8000;
const CARD_MAX_PARAGRAPHS = 64;
const CARD_MAX_CHILDREN_PER_EXPANSION = 100;
const CARD_LEGACY_MAX_INLINE_NODES = 500;

function sanitizeCardText(raw: string): string {
  // Strip ANSI escape sequences and control characters (CWE-117)
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Extract text from a single card element node.
 * Returns extracted text fragments for the node.
 */
function extractCardTextFromElement(item: Record<string, unknown>): string[] {
  const tag = item.tag;
  if (typeof tag !== "string") return [];

  const fragments: string[] = [];

  // div: text.content
  if (tag === "div") {
    const text = item.text as { content?: string } | undefined;
    if (typeof text?.content === "string") fragments.push(text.content);
    return fragments;
  }

  // markdown / lark_md: content string
  if ((tag === "markdown" || tag === "lark_md") && typeof item.content === "string") {
    fragments.push(item.content);
    return fragments;
  }

  // plain_text: content string
  if (tag === "plain_text" && typeof item.content === "string") {
    fragments.push(item.content);
    return fragments;
  }

  // header: title (string or object with content)
  if (tag === "header") {
    const title = item.title;
    if (typeof title === "string") {
      fragments.push(title);
    } else if (
      title &&
      typeof title === "object" &&
      typeof (title as Record<string, unknown>).content === "string"
    ) {
      fragments.push((title as Record<string, unknown>).content as string);
    }
    const subtitle = item.subtitle;
    if (typeof subtitle === "string") {
      fragments.push(subtitle);
    } else if (
      subtitle &&
      typeof subtitle === "object" &&
      typeof (subtitle as Record<string, unknown>).content === "string"
    ) {
      fragments.push((subtitle as Record<string, unknown>).content as string);
    }
    return fragments;
  }

  return fragments;
}

/**
 * Extract text from legacy rich-text content (array-of-arrays format).
 * Each paragraph is an array of inline tag objects like {tag:"text",text:"..."}.
 */
function extractLegacyContentText(content: unknown, maxChars: number): string[] {
  if (!Array.isArray(content)) return [];
  const fragments: string[] = [];
  let totalChars = 0;
  let queuedArrays = 0;
  let nodesScanned = 0;

  for (const paragraph of content) {
    if (++queuedArrays > CARD_MAX_PARAGRAPHS) break;
    if (!Array.isArray(paragraph)) continue;

    for (const inline of paragraph) {
      if (totalChars >= maxChars) return fragments;
      if (++nodesScanned > CARD_LEGACY_MAX_INLINE_NODES) return fragments;
      if (!inline || typeof inline !== "object") continue;
      const node = inline as Record<string, unknown>;
      const nodeTag = node.tag;
      if (typeof nodeTag !== "string") continue;

      let text: string | undefined;
      if (nodeTag === "text" && typeof node.text === "string") {
        text = node.text;
      } else if (nodeTag === "a" && typeof node.text === "string") {
        text = node.text;
      } else if (nodeTag === "at") {
        const name = node.user_name ?? node.user_id ?? node.open_id;
        if (typeof name === "string") text = `@${name}`;
      } else if (nodeTag === "code_block" && typeof node.text === "string") {
        text = node.text;
      }

      if (text) {
        const remaining = maxChars - totalChars;
        const clamped = text.length > remaining ? text.slice(0, remaining) : text;
        fragments.push(clamped);
        totalChars += clamped.length;
      }
    }
  }
  return fragments;
}

function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const card = parsed as Record<string, unknown>;
  const texts: string[] = [];
  let totalChars = 0;

  // Extract top-level title (some legacy formats)
  if (typeof card.title === "string" && card.title.trim()) {
    const remaining = CARD_MAX_OUTPUT_CHARS - totalChars;
    if (remaining > 0) {
      const clamped = card.title.length > remaining ? card.title.slice(0, remaining) : card.title;
      texts.push(clamped);
      totalChars += clamped.length;
    }
  }

  // Extract legacy rich-text content (array-of-arrays)
  if (Array.isArray(card.content)) {
    const legacyTexts = extractLegacyContentText(card.content, CARD_MAX_OUTPUT_CHARS - totalChars);
    for (const t of legacyTexts) {
      texts.push(t);
      totalChars += t.length;
    }
  }

  // Collect elements from schema 1.0 (card.elements) and 2.0 (card.body.elements)
  const elementSources: unknown[] = [];
  if (Array.isArray(card.elements)) {
    elementSources.push(...card.elements);
  }
  const body = card.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && Array.isArray(body.elements)) {
    elementSources.push(...body.elements);
  }

  // DFS traversal with bounds
  const stack: unknown[] = [];
  const maxInitialElements = CARD_MAX_NODES;
  const pushLimit = Math.min(elementSources.length, maxInitialElements);
  // Push in reverse so first element is processed first
  for (let i = pushLimit - 1; i >= 0; i--) {
    stack.push(elementSources[i]);
  }

  const stackSizeLimit = CARD_MAX_NODES * 4;
  let nodesVisited = 0;
  while (stack.length > 0 && nodesVisited < CARD_MAX_NODES && totalChars < CARD_MAX_OUTPUT_CHARS) {
    if (stack.length > stackSizeLimit) break;
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    nodesVisited++;

    const item = current as Record<string, unknown>;
    const tag = item.tag;

    // Recurse into container tags: note, column_set -> columns -> elements
    if (typeof tag === "string") {
      if (tag === "note" && Array.isArray(item.elements)) {
        const elems = (item.elements as unknown[]).slice(0, CARD_MAX_CHILDREN_PER_EXPANSION);
        for (let i = elems.length - 1; i >= 0; i--) {
          stack.push(elems[i]);
        }
        continue;
      }
      if (tag === "column_set" && Array.isArray(item.columns)) {
        const cols = (item.columns as unknown[]).slice(0, CARD_MAX_CHILDREN_PER_EXPANSION);
        for (let ci = cols.length - 1; ci >= 0; ci--) {
          const col = cols[ci] as Record<string, unknown> | undefined;
          if (col && Array.isArray(col.elements)) {
            const colElems = (col.elements as unknown[]).slice(0, CARD_MAX_CHILDREN_PER_EXPANSION);
            for (let ei = colElems.length - 1; ei >= 0; ei--) {
              stack.push(colElems[ei]);
            }
          }
        }
        continue;
      }
    }

    // Extract text from leaf elements
    const fragments = extractCardTextFromElement(item);
    for (const fragment of fragments) {
      const remaining = CARD_MAX_OUTPUT_CHARS - totalChars;
      if (remaining <= 0) break;
      const clamped = fragment.length > remaining ? fragment.slice(0, remaining) : fragment;
      texts.push(clamped);
      totalChars += clamped.length;
    }
  }

  const raw = texts.join("\n").trim();
  return raw ? sanitizeCardText(raw) : "[Interactive Card]";
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
    })) as FeishuGetMessageResponse;

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
      chatType:
        item.chat_type === "group" || item.chat_type === "private" || item.chat_type === "p2p"
          ? item.chat_type
          : undefined,
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
  return sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    content,
    msgType,
    directParams,
    directErrorPrefix: "Feishu send failed",
    replyErrorPrefix: "Feishu reply failed",
  });
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
  return sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    content,
    msgType: "interactive",
    directParams,
    directErrorPrefix: "Feishu card send failed",
    replyErrorPrefix: "Feishu card reply failed",
  });
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
