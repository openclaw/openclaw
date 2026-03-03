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

const CARD_MAX_NODES = 500;
const CARD_MAX_OUTPUT_CHARS = 8000;
// Cap the number of child-arrays enqueued to prevent wide column_set or note
// structures from causing unbounded queue growth / memory exhaustion.
const CARD_MAX_QUEUED_ARRAYS = 64;

// Strip ANSI CSI/OSC escape sequences and non-printable control characters
// (except \n and \t) from card text before it reaches logs or LLM context.
// Prevents log/terminal injection via attacker-influenced card payloads (CWE-117).
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeCardText(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}

/**
 * Iterative DFS extraction of visible text from a Feishu interactive card.
 * Uses a LIFO stack (push/pop) so nested content is emitted in document order —
 * a FIFO queue would emit nested blocks after later siblings, inverting layout.
 *
 * Bounded by CARD_MAX_NODES (total elements visited, including column entries),
 * CARD_MAX_OUTPUT_CHARS, and CARD_MAX_QUEUED_ARRAYS to prevent DoS from
 * deeply-nested or wide attacker-influenced card payloads.
 */
function extractCardTextElements(root: unknown[]): string[] {
  const out: string[] = [];
  // LIFO stack: push children in reverse so first child is processed first.
  const stack: unknown[][] = [root];
  let seenNodes = 0;
  let outChars = 0;

  const pushText = (s: string) => {
    if (!s || outChars >= CARD_MAX_OUTPUT_CHARS) return;
    const clean = sanitizeCardText(s);
    const clipped = clean.slice(0, CARD_MAX_OUTPUT_CHARS - outChars);
    out.push(clipped);
    outChars += clipped.length;
  };

  const enqueue = (arr: unknown[]) => {
    if (stack.length < CARD_MAX_QUEUED_ARRAYS) stack.push(arr);
  };

  while (stack.length > 0 && seenNodes < CARD_MAX_NODES && outChars < CARD_MAX_OUTPUT_CHARS) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const nodes = stack.pop()!;
    for (const element of nodes) {
      if (++seenNodes > CARD_MAX_NODES) break;
      if (!element || typeof element !== "object") continue;

      // Legacy post/rich-text format: elements/content is array-of-arrays where each
      // inner array is a row of inline elements. Supported tags:
      //   text, a (link), at (mention) → extract .text
      //   code_block → extract .text
      //   img, media, emotion, hr → skip (no readable text)
      if (Array.isArray(element)) {
        for (const inline of element as unknown[]) {
          if (!inline || typeof inline !== "object") continue;
          const inEl = inline as Record<string, unknown>;
          const inTag = inEl.tag;
          if (
            (inTag === "text" || inTag === "a" || inTag === "code_block") &&
            typeof inEl.text === "string" &&
            inEl.text.trim()
          ) {
            pushText(inEl.text.trim());
          } else if (
            inTag === "at" &&
            typeof inEl.user_name === "string" &&
            inEl.user_name.trim()
          ) {
            // at-mention: use user_name as display text
            pushText(inEl.user_name.trim());
          }
        }
        continue;
      }

      const el = element as Record<string, unknown>;
      const tag = el.tag;

      if (tag === "div" && el.text && typeof el.text === "object") {
        const c = (el.text as Record<string, unknown>).content;
        if (typeof c === "string") pushText(c);
      } else if (
        (tag === "markdown" || tag === "plain_text" || tag === "lark_md") &&
        typeof el.content === "string"
      ) {
        pushText(el.content);
      } else if (tag === "header" && el.title && typeof el.title === "object") {
        const c = (el.title as Record<string, unknown>).content;
        if (typeof c === "string") pushText(c);
      } else if (tag === "note" && Array.isArray(el.elements)) {
        enqueue(el.elements as unknown[]);
      } else if (tag === "column_set" && Array.isArray(el.columns)) {
        // Each column entry counts against seenNodes regardless of whether it
        // has extractable elements — this bounds the scan cost for wide arrays
        // containing mostly empty/malformed column objects.
        // Push in reverse so that popping (LIFO) processes columns in original order.
        const cols = el.columns as unknown[];
        for (let i = cols.length - 1; i >= 0; i--) {
          if (++seenNodes > CARD_MAX_NODES) break;
          const col = cols[i];
          if (
            col &&
            typeof col === "object" &&
            Array.isArray((col as Record<string, unknown>).elements)
          ) {
            enqueue((col as Record<string, unknown>).elements as unknown[]);
            if (stack.length >= CARD_MAX_QUEUED_ARRAYS) break; // hard fanout cap
          }
        }
      }
    }
  }

  return out;
}

function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const card = parsed as Record<string, unknown>;
  const texts: string[] = [];

  // Legacy format: top-level "title" string (not inside a header object)
  if (typeof card.title === "string" && card.title) {
    texts.push(card.title);
  }

  // Extract header title if present (sits outside the elements array)
  if (card.header && typeof card.header === "object") {
    texts.push(
      ...extractCardTextElements([
        { tag: "header", title: (card.header as Record<string, unknown>).title },
      ]),
    );
  }

  // Extract body — priority order:
  // 1. card.elements  — schema 1.0 flat elements array
  // 2. card.body.elements — schema 2.0 (buildMarkdownCard, modern alert cards)
  // 3. card.content — legacy post/rich-text format (array-of-arrays rows)
  const bodyElements = Array.isArray(card.elements)
    ? (card.elements as unknown[])
    : card.body &&
        typeof card.body === "object" &&
        Array.isArray((card.body as Record<string, unknown>).elements)
      ? ((card.body as Record<string, unknown>).elements as unknown[])
      : Array.isArray(card.content)
        ? (card.content as unknown[])
        : [];
  texts.push(...extractCardTextElements(bodyElements));

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
