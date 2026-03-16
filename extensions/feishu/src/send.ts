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
const FEISHU_CARD_TEMPLATES = new Set([
  "blue",
  "green",
  "red",
  "orange",
  "purple",
  "indigo",
  "wathet",
  "turquoise",
  "yellow",
  "grey",
  "carmine",
  "violet",
  "lime",
]);

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
  thread_id?: string;
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

  const threadReplyFallbackError = params.replyInThread
    ? new Error(
        "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
      )
    : null;

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
    if (threadReplyFallbackError) {
      throw threadReplyFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  if (shouldFallbackFromReplyTarget(response)) {
    if (threadReplyFallbackError) {
      throw threadReplyFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
  return toFeishuSendResult(response, params.directParams.receiveId);
}

/**
 * Recursively extract readable text from a Feishu interactive card element tree.
 * Handles v1 (flat elements[]) and v2 (schema 2.0, body.elements[]) card formats,
 * including nested structures like column_set, note, action buttons, etc.
 */
export function extractCardElementTexts(elements: unknown[]): string[] {
  const texts: string[] = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const el = element as Record<string, unknown>;
    const tag = el.tag as string | undefined;

    // markdown element: { tag: "markdown", content: "..." }
    if (tag === "markdown" && typeof el.content === "string") {
      texts.push(el.content);
      continue;
    }

    // div element: { tag: "div", text: { content: "..." } }
    if (tag === "div") {
      const text = el.text as { content?: string; tag?: string } | undefined;
      if (typeof text?.content === "string") {
        texts.push(text.content);
      }
      // div can also have extra[] (additional text/image elements)
      if (Array.isArray(el.extra)) {
        texts.push(...extractCardElementTexts(el.extra));
      }
      continue;
    }

    // plain_text / lark_md text objects (used inside div, note, etc.)
    if ((tag === "plain_text" || tag === "lark_md") && typeof el.content === "string") {
      texts.push(el.content);
      continue;
    }

    // hr (horizontal rule) — skip silently
    if (tag === "hr") continue;

    // img element: { tag: "img", alt: { content: "..." } }
    if (tag === "img") {
      const alt = el.alt as { content?: string } | undefined;
      if (typeof alt?.content === "string" && alt.content.trim()) {
        texts.push(`[Image: ${alt.content}]`);
      } else {
        texts.push("[Image]");
      }
      continue;
    }

    // note element: { tag: "note", elements: [...] }
    if (tag === "note" && Array.isArray(el.elements)) {
      const noteTexts = extractCardElementTexts(el.elements as unknown[]);
      if (noteTexts.length > 0) {
        texts.push(`[Note: ${noteTexts.join(" ")}]`);
      }
      continue;
    }

    // action element: { tag: "action", actions: [...] }
    if (tag === "action" && Array.isArray(el.actions)) {
      for (const action of el.actions) {
        if (!action || typeof action !== "object") continue;
        const act = action as Record<string, unknown>;
        const actText = act.text as { content?: string } | undefined;
        if (typeof actText?.content === "string") {
          texts.push(`[Button: ${actText.content}]`);
        }
      }
      continue;
    }

    // column_set element: { tag: "column_set", columns: [{ elements: [...] }] }
    if (tag === "column_set" && Array.isArray(el.columns)) {
      for (const col of el.columns) {
        if (!col || typeof col !== "object") continue;
        const column = col as { elements?: unknown[] };
        if (Array.isArray(column.elements)) {
          texts.push(...extractCardElementTexts(column.elements));
        }
      }
      continue;
    }

    // collapsible_panel: { tag: "collapsible_panel", elements: [...], header: {...} }
    if (tag === "collapsible_panel") {
      if (el.header && typeof el.header === "object") {
        const header = el.header as { title?: { content?: string } };
        if (typeof header.title?.content === "string") {
          texts.push(header.title.content);
        }
      }
      if (Array.isArray(el.elements)) {
        texts.push(...extractCardElementTexts(el.elements as unknown[]));
      }
      continue;
    }

    // table element: { tag: "table", columns: [...], rows: [...] }
    if (tag === "table") {
      const columns = el.columns as Array<{ name?: string; display_name?: string }> | undefined;
      const rows = el.rows as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(columns) && Array.isArray(rows)) {
        const colNames = columns.map((c) => c.display_name || c.name || "");
        texts.push(`| ${colNames.join(" | ")} |`);
        for (const row of rows) {
          const vals = columns.map((c) => {
            const key = c.name || "";
            const val = row[key];
            return typeof val === "string" ? val : val != null ? String(val) : "";
          });
          texts.push(`| ${vals.join(" | ")} |`);
        }
      }
      continue;
    }

    // Generic fallback: if element has nested elements[], recurse
    if (Array.isArray(el.elements)) {
      texts.push(...extractCardElementTexts(el.elements as unknown[]));
      continue;
    }

    // Fallback: try to extract any text/content field
    if (typeof el.content === "string" && el.content.trim()) {
      texts.push(el.content);
    } else if (typeof (el.text as { content?: string })?.content === "string") {
      texts.push((el.text as { content: string }).content);
    }
  }
  return texts;
}

export function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const card = parsed as Record<string, unknown>;
  const parts: string[] = [];

  // Extract header title (both v1 and v2)
  if (card.header && typeof card.header === "object") {
    const header = card.header as { title?: { content?: string; tag?: string } };
    if (typeof header.title?.content === "string" && header.title.content.trim()) {
      parts.push(`**${header.title.content.trim()}**`);
    }
  }

  // v2 cards: body.elements[]
  const body = card.body as { elements?: unknown[] } | undefined;
  if (body && Array.isArray(body.elements)) {
    parts.push(...extractCardElementTexts(body.elements));
  }

  // v1 cards: elements[] at top level
  if (Array.isArray(card.elements)) {
    parts.push(...extractCardElementTexts(card.elements as unknown[]));
  }

  return parts.join("\n").trim() || "[Interactive Card]";
}

function parseFeishuMessageContent(rawContent: string, msgType: string): string {
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

function parseFeishuMessageItem(
  item: FeishuMessageGetItem,
  fallbackMessageId?: string,
): FeishuMessageInfo {
  const msgType = item.msg_type ?? "text";
  const rawContent = item.body?.content ?? "";

  return {
    messageId: item.message_id ?? fallbackMessageId ?? "",
    chatId: item.chat_id ?? "",
    chatType:
      item.chat_type === "group" || item.chat_type === "private" || item.chat_type === "p2p"
        ? item.chat_type
        : undefined,
    senderId: item.sender?.id,
    senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
    senderType: item.sender?.sender_type,
    content: parseFeishuMessageContent(rawContent, msgType),
    contentType: msgType,
    createTime: item.create_time ? parseInt(String(item.create_time), 10) : undefined,
    threadId: item.thread_id || undefined,
  };
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

    return parseFeishuMessageItem(item, messageId);
  } catch {
    return null;
  }
}

export type FeishuThreadMessageInfo = {
  messageId: string;
  senderId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

/**
 * List messages in a Feishu thread (topic).
 * Uses container_id_type=thread to directly query thread messages,
 * which includes both the root message and all replies (including bot replies).
 */
export async function listFeishuThreadMessages(params: {
  cfg: ClawdbotConfig;
  threadId: string;
  currentMessageId?: string;
  /** Exclude the root message (already provided separately as ThreadStarterBody). */
  rootMessageId?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuThreadMessageInfo[]> {
  const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = (await client.im.message.list({
    params: {
      container_id_type: "thread",
      container_id: threadId,
      // Fetch newest messages first so long threads keep the most recent turns.
      // Results are reversed below to restore chronological order.
      sort_type: "ByCreateTimeDesc",
      page_size: Math.min(limit + 1, 50),
    },
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<
        {
          message_id?: string;
          root_id?: string;
          parent_id?: string;
        } & FeishuMessageGetItem
      >;
    };
  };

  if (response.code !== 0) {
    throw new Error(
      `Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
    );
  }

  const items = response.data?.items ?? [];
  const results: FeishuThreadMessageInfo[] = [];

  for (const item of items) {
    if (currentMessageId && item.message_id === currentMessageId) continue;
    if (rootMessageId && item.message_id === rootMessageId) continue;

    const parsed = parseFeishuMessageItem(item);

    results.push({
      messageId: parsed.messageId,
      senderId: parsed.senderId,
      senderType: parsed.senderType,
      content: parsed.content,
      contentType: parsed.contentType,
      createTime: parsed.createTime,
    });

    if (results.length >= limit) break;
  }

  // Restore chronological order (oldest first) since we fetched newest-first.
  results.reverse();
  return results;
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

export function buildFeishuPostMessagePayload(params: { messageText: string }): {
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

export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text?: string;
  card?: Record<string, unknown>;
  accountId?: string;
}): Promise<{ messageId: string; contentType: "post" | "interactive" }> {
  const { cfg, messageId, text, card, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const hasText = typeof text === "string" && text.trim().length > 0;
  const hasCard = Boolean(card);
  if (hasText === hasCard) {
    throw new Error("Feishu edit requires exactly one of text or card.");
  }

  const client = createFeishuClient(account);

  if (card) {
    const content = JSON.stringify(card);
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
    }

    return { messageId, contentType: "interactive" };
  }

  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(text!, tableMode);
  const payload = buildFeishuPostMessagePayload({ messageText });
  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: payload.content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }

  return { messageId, contentType: "post" };
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

/** Header configuration for structured Feishu cards. */
export type CardHeaderConfig = {
  /** Header title text, e.g. "💻 Coder" */
  title: string;
  /** Feishu header color template (blue, green, red, orange, purple, grey, etc.). Defaults to "blue". */
  template?: string;
};

export function resolveFeishuCardTemplate(template?: string): string | undefined {
  const normalized = template?.trim().toLowerCase();
  if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Build a Feishu interactive card with optional header and note footer.
 * When header/note are omitted, behaves identically to buildMarkdownCard.
 */
export function buildStructuredCard(
  text: string,
  options?: {
    header?: CardHeaderConfig;
    note?: string;
  },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content: text }];
  if (options?.note) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<font color='grey'>${options.note}</font>` });
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
  if (options?.header) {
    card.header = {
      title: { tag: "plain_text", content: options.header.title },
      template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
    };
  }
  return card;
}

/**
 * Send a message as a structured card with optional header and note.
 */
export async function sendStructuredCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  mentions?: MentionTarget[];
  accountId?: string;
  header?: CardHeaderConfig;
  note?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId, header, note } =
    params;
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildStructuredCard(cardText, { header, note });
  return sendCardFeishu({ cfg, to, card, replyToMessageId, replyInThread, accountId });
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
