import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
} from "openclaw/plugin-sdk/text-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount, resolveFeishuRuntimeAccount } from "./accounts.js";
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

function sanitizeFeishuTextForDelivery(text: string): string {
  return stripInlineDirectiveTagsForDelivery(text).text;
}

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
  mentions?: Array<{
    key?: string;
    name?: string;
    id?: { open_id?: string; user_id?: string; union_id?: string };
  }>;
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
  const runtimeLog = (getFeishuRuntime() as unknown as { log?: (message: string) => void }).log;
  if (!params.replyToMessageId) {
    runtimeLog?.(
      `feishu send direct-create msgType=${params.msgType} receiveId=${params.directParams.receiveId} receiveIdType=${params.directParams.receiveIdType}`,
    );
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }

  const threadReplyFallbackError = params.replyInThread
    ? new Error(
        "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
      )
    : null;

  let response: { code?: number; msg?: string; data?: { message_id?: string } };
  try {
    runtimeLog?.(
      `feishu send reply-attempt msgType=${params.msgType} replyTo=${params.replyToMessageId} replyInThread=${params.replyInThread ? "true" : "false"} receiveId=${params.directParams.receiveId}`,
    );
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
    runtimeLog?.(
      `feishu send reply-fallback-on-throw msgType=${params.msgType} replyTo=${params.replyToMessageId} replyInThread=${params.replyInThread ? "true" : "false"}`,
    );
    if (threadReplyFallbackError) {
      throw threadReplyFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  if (shouldFallbackFromReplyTarget(response)) {
    runtimeLog?.(
      `feishu send reply-fallback-on-response msgType=${params.msgType} replyTo=${params.replyToMessageId} replyInThread=${params.replyInThread ? "true" : "false"} code=${response.code ?? "unknown"}`,
    );
    if (threadReplyFallbackError) {
      throw threadReplyFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
  runtimeLog?.(
    `feishu send reply-ok msgType=${params.msgType} replyTo=${params.replyToMessageId} replyInThread=${params.replyInThread ? "true" : "false"} messageId=${response.data?.message_id ?? "unknown"}`,
  );
  return toFeishuSendResult(response, params.directParams.receiveId);
}

function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  // Support both schema 1.0 (top-level `elements`) and 2.0 (`body.elements`).
  const candidate = parsed as { elements?: unknown; body?: { elements?: unknown } };
  const elements = Array.isArray(candidate.elements)
    ? candidate.elements
    : Array.isArray(candidate.body?.elements)
      ? candidate.body!.elements
      : null;
  if (!elements) {
    return "[Interactive Card]";
  }

  const texts: string[] = [];
  for (const element of elements) {
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
    content: enrichMentionPlaceholders(
      parseFeishuMessageContent(rawContent, msgType),
      item.mentions,
    ),
    contentType: msgType,
    createTime: item.create_time ? parseInt(String(item.create_time), 10) : undefined,
    threadId: item.thread_id || undefined,
  };
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
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
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

/**
 * List messages in a Feishu chat (group or p2p).
 * Uses container_id_type=chat to query chat messages with optional pagination.
 */
export async function listFeishuChatMessages(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  limit?: number;
  pageToken?: string;
  accountId?: string;
}): Promise<{ messages: FeishuMessageInfo[]; pageToken?: string }> {
  const { cfg, chatId, limit = 20, pageToken, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const pageSize = Math.min(Math.max(limit, 1), 50);
  const response = (await client.im.message.list({
    params: {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: pageSize,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: FeishuMessageGetItem[];
      page_token?: string;
      has_more?: boolean;
    };
  };

  if (response.code !== 0) {
    throw new Error(
      `Feishu chat message list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
    );
  }

  const items = response.data?.items ?? [];
  const messages: FeishuMessageInfo[] = [];

  for (const item of items) {
    messages.push(parseFeishuMessageItem(item));
    if (messages.length >= limit) break;
  }

  // Return newest-first (consistent with API sort and pagination token direction).
  return {
    messages,
    pageToken: response.data?.has_more ? response.data.page_token : undefined,
  };
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
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
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
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";
  if (renderMode === "card") {
    return sendMarkdownCardFeishu({
      cfg,
      to,
      text,
      replyToMessageId,
      replyInThread,
      mentions,
      accountId,
    });
  }
  const mentionMeta = buildMentionMeta(mentions);
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = sanitizeFeishuTextForDelivery(text ?? "");
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  rawText = normalizeMentionTagsForText(rawText, buildMentionDisplayNameMap(mentions));
  const messageText = convertMarkdownTables(rawText, tableMode);

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
  mentions?: MentionTarget[];
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, mentions, accountId } = params;
  const mentionMeta = buildMentionMeta(mentions);
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const content = JSON.stringify(normalizeCardMentionTags(card));

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
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
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
    const content = JSON.stringify(normalizeCardMentionTags(card));
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
    }

    return { messageId, contentType: "interactive" };
  }

  const renderMode = account.config?.renderMode ?? "auto";
  if (renderMode === "card" || (renderMode === "auto" && shouldUseFeishuMarkdownCard(text!))) {
    const normalizedCardText = normalizeMentionTagsForCard(sanitizeFeishuTextForDelivery(text!));
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildMarkdownCard(normalizedCardText)) },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
    }

    return { messageId, contentType: "interactive" };
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = convertMarkdownTables(sanitizeFeishuTextForDelivery(text!), tableMode);
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
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
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

export function shouldUseFeishuMarkdownCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  const normalizedText = normalizeMentionTagsForCard(sanitizeFeishuTextForDelivery(text));
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: normalizedText,
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
    thinkingTitle?: string;
    thinkingText?: string;
    thinkingExpanded?: boolean;
  },
): Record<string, unknown> {
  const normalizedText = normalizeMentionTagsForCard(sanitizeFeishuTextForDelivery(text));
  const elements: Record<string, unknown>[] = [];
  const thinkingText = options?.thinkingText?.trim();
  if (thinkingText) {
    elements.push({
      tag: "collapsible_panel",
      expanded: options?.thinkingExpanded ?? false,
      element_id: "thinking",
      header: {
        title: {
          tag: "plain_text",
          content: options?.thinkingTitle?.trim() || "💭 Thinking",
        },
      },
      border: { color: "grey" },
      vertical_spacing: "2px",
      padding: "4px 12px",
      elements: [{ tag: "markdown", content: thinkingText, element_id: "thinking_content" }],
    });
  }
  elements.push({ tag: "markdown", content: normalizedText });
  if (options?.note) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<font color='grey'>${options.note}</font>` });
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { width_mode: "fill" },
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
  thinkingTitle?: string;
  thinkingText?: string;
  thinkingExpanded?: boolean;
}): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    replyToMessageId,
    replyInThread,
    mentions,
    accountId,
    header,
    note,
    thinkingTitle,
    thinkingText,
    thinkingExpanded,
  } = params;
  let cardText = normalizeMentionTagsForCard(text);
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, cardText);
  }
  const card = buildStructuredCard(cardText, {
    header,
    note,
    thinkingTitle,
    thinkingText,
    thinkingExpanded,
  });
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
  cardText = normalizeMentionTagsForCard(cardText);
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, replyInThread, mentions, accountId });
}
