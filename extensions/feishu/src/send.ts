import type * as Lark from "@larksuiteoapi/node-sdk";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { createFeishuClient } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { createConfiguredFeishuClient } from "./configured-client.js";
import { parseInteractiveCardContent } from "./interactive-message-content.js";
import {
  assertFeishuPostWithinEnvelope,
  buildFeishuPostMessageContent,
  chunkFeishuMarkdownByEnvelope,
  materializeFeishuPostMarkdownSoftBreaks,
  type FeishuMarkdownChunkOptions,
} from "./markdown.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import { parseMergeForwardContent } from "./message-content.js";
import { resolveFeishuCardTemplate } from "./native-card.js";
import { renderPostContent } from "./post.js";
import { withFeishuMessageDispatch } from "./send-context.js";
import { resolveFeishuReceiptKind, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import {
  normalizeFeishuEventChatType,
  type FeishuChatType,
  type FeishuMessageInfo,
  type FeishuSendResult,
} from "./types.js";

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true;
  }
  const msg = normalizeLowercaseStringOrEmpty(response.msg);
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
  // Wrapped error shape from createFeishuApiError: err.cause holds the original error.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    return isWithdrawnReplyError(cause);
  }
  return false;
}

type FeishuSdkGetMessageResponse = Awaited<ReturnType<Lark.Client["im"]["message"]["get"]>>;
type FeishuMessageGetItem = NonNullable<
  NonNullable<FeishuSdkGetMessageResponse["data"]>["items"]
>[number] & { chat_type?: FeishuChatType };

type FeishuGetMessageResponse = Omit<FeishuSdkGetMessageResponse, "data"> & {
  data?: FeishuMessageGetItem & {
    items?: FeishuMessageGetItem[];
  };
};

export async function sendReplyOrFallbackDirect(
  target: ReturnType<typeof resolveFeishuSendTarget>,
  params: {
    replyToMessageId?: string;
    replyInThread?: boolean;
    allowTopLevelReplyFallback?: boolean;
    content: string;
    msgType: string;
    directErrorPrefix: string;
    replyErrorPrefix: string;
  },
): Promise<FeishuSendResult> {
  const { client, receiveId, receiveIdType } = target;
  const sendDirect = async (): Promise<FeishuSendResult> => {
    const response = await requestFeishuApi(
      () =>
        withFeishuMessageDispatch(() =>
          client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: receiveId,
              content: params.content,
              msg_type: params.msgType,
            },
          }),
        ),
      params.directErrorPrefix,
      { includeNestedErrorLogId: true },
    );
    assertFeishuApiSuccess(response, params.directErrorPrefix);
    return toFeishuSendResult(
      response,
      receiveId,
      resolveFeishuReceiptKind(params.msgType),
      params.directErrorPrefix,
    );
  };
  if (!params.replyToMessageId) {
    return sendDirect();
  }

  const replyTargetFallbackError =
    params.replyInThread && params.allowTopLevelReplyFallback !== true
      ? new Error(
          "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
        )
      : null;

  let response: { code?: number; msg?: string; data?: { message_id?: string } };
  try {
    response = await requestFeishuApi(
      () =>
        withFeishuMessageDispatch(() =>
          client.im.message.reply({
            path: { message_id: params.replyToMessageId! },
            data: {
              content: params.content,
              msg_type: params.msgType,
              ...(params.replyInThread ? { reply_in_thread: true } : {}),
            },
          }),
        ),
      params.replyErrorPrefix,
      { includeNestedErrorLogId: true },
    );
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      throw err;
    }
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendDirect();
  }
  if (shouldFallbackFromReplyTarget(response)) {
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendDirect();
  }
  assertFeishuApiSuccess(response, params.replyErrorPrefix);
  return toFeishuSendResult(
    response,
    receiveId,
    resolveFeishuReceiptKind(params.msgType),
    params.replyErrorPrefix,
    params.replyToMessageId,
  );
}

function parseFeishuMessageContent(
  rawContent: string,
  msgType: string,
  messageId?: string,
): string {
  if (!rawContent) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const safeId = messageId ? ` (id: ${messageId})` : "";
    logVerbose(`feishu message content parse failed for ${msgType} message${safeId}`);
    return rawContent;
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "[Text message]";
  }

  if (msgType === "post") {
    return renderPostContent(parsed).textContent;
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
    chatType: normalizeFeishuEventChatType(item.chat_type),
    senderId: item.sender?.id,
    senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
    senderType: item.sender?.sender_type,
    content: parseFeishuMessageContent(rawContent, msgType, item.message_id),
    contentType: msgType,
    createTime: parseStrictNonNegativeInteger(item.create_time),
    ...(item.root_id ? { rootId: item.root_id } : {}),
    threadId: item.thread_id || undefined,
  };
}

export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const client = createConfiguredFeishuClient({ cfg, accountId });

  try {
    const response = (await client.im.message.get({
      params: { card_msg_content_type: "user_card_content" },
      path: { message_id: messageId },
    })) as FeishuGetMessageResponse;

    if (response.code !== 0) {
      return null;
    }

    // Support both list shape (including flattened merged forwards) and single-object shape.
    const responseItems = response.data?.items;
    const rawItem =
      responseItems?.find((item) => item.msg_type === "merge_forward" && !item.upper_message_id) ??
      responseItems?.[0] ??
      response.data;
    const item =
      rawItem && (rawItem.body !== undefined || rawItem.message_id !== undefined) ? rawItem : null;
    if (!item) {
      return null;
    }

    const parsedItem = parseFeishuMessageItem(item, messageId);
    if (parsedItem.contentType === "merge_forward" && responseItems) {
      return {
        ...parsedItem,
        content: parseMergeForwardContent(responseItems),
      };
    }
    return parsedItem;
  } catch {
    return null;
  }
}

type FeishuThreadMessageInfo = Pick<
  FeishuMessageInfo,
  "messageId" | "senderId" | "senderType" | "content" | "contentType" | "createTime"
>;

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
  const client = createConfiguredFeishuClient({ cfg, accountId });

  const results: FeishuThreadMessageInfo[] = [];
  const seenMessageIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  while (results.length < limit) {
    const response = await client.im.message.list({
      params: {
        container_id_type: "thread",
        container_id: threadId,
        // Feishu pages newest-first; reverse only after all accepted pages are gathered.
        sort_type: "ByCreateTimeDesc",
        page_size: Math.min(limit + 1, 50),
        ...(pageToken ? { page_token: pageToken } : {}),
        card_msg_content_type: "user_card_content",
      },
    });

    if (response.code !== 0) {
      throw new Error(
        `Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
      );
    }

    for (const item of response.data?.items ?? []) {
      if (
        (currentMessageId && item.message_id === currentMessageId) ||
        (rootMessageId && item.message_id === rootMessageId) ||
        (item.message_id && seenMessageIds.has(item.message_id))
      ) {
        continue;
      }

      const parsed = parseFeishuMessageItem(item);
      if (parsed.messageId) {
        seenMessageIds.add(parsed.messageId);
      }
      results.push({
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderType: parsed.senderType,
        content: parsed.content,
        contentType: parsed.contentType,
        createTime: parsed.createTime,
      });

      if (results.length >= limit) {
        break;
      }
    }

    if (results.length >= limit || response.data?.has_more !== true) {
      break;
    }

    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      throw new Error(
        `Feishu thread history pagination returned a ${nextPageToken ? "repeated" : "missing"} page token`,
      );
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  // Restore chronological order (oldest first) since we fetched newest-first.
  results.reverse();
  return results;
}

type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  /** The outbound adapter already projected and envelope-chunked this post text. @internal */
  preparedPostText?: true;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const { cfg, text, preparedPostText, mentions } = params;
  const target = resolveFeishuSendTarget(params);
  let messageText = text;
  if (!preparedPostText) {
    const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
    messageText = materializeFeishuPostMarkdownSoftBreaks(
      convertMarkdownTables(text ?? "", tableMode),
    );
  }

  const content = buildFeishuPostMessageContent({ messageText, mentions });
  assertFeishuPostWithinEnvelope(content, "Feishu post");

  return sendReplyOrFallbackDirect(target, {
    ...params,
    content,
    msgType: "post",
    directErrorPrefix: "Feishu send failed",
    replyErrorPrefix: "Feishu reply failed",
  });
}

type SendFeishuCardParams = Omit<
  SendFeishuMessageParams,
  "text" | "preparedPostText" | "mentions"
> & {
  card: Record<string, unknown>;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const target = resolveFeishuSendTarget(params);
  return sendReplyOrFallbackDirect(target, {
    ...params,
    content: JSON.stringify(params.card),
    msgType: "interactive",
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
    const content = JSON.stringify(card);
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    assertFeishuApiSuccess(response, "Feishu message edit failed");

    return { messageId, contentType: "interactive" };
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = convertMarkdownTables(text!, tableMode);
  const normalizedText = materializeFeishuPostMarkdownSoftBreaks(messageText);
  const content = buildFeishuPostMessageContent({ messageText: normalizedText });
  assertFeishuPostWithinEnvelope(content, "Feishu message edit");
  // Feishu's PATCH endpoint only edits cards; rich-post edits require the typed PUT endpoint.
  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: { msg_type: "post", content },
  });

  assertFeishuApiSuccess(response, "Feishu message edit failed");

  return { messageId, contentType: "post" };
}

export type CardHeaderConfig = {
  title: string;
  /** Feishu header color template (blue, green, red, orange, purple, grey, etc.). Defaults to "blue". */
  template?: string;
};

function buildStructuredCard(
  text: string,
  options?: {
    header?: CardHeaderConfig;
    note?: string;
    mentions?: MentionTarget[];
  },
): Record<string, unknown> {
  const content = options?.mentions?.length
    ? buildMentionedCardContent(options.mentions, text)
    : text;
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content }];
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

export function chunkFeishuCardMarkdown(
  params: FeishuMarkdownChunkOptions & {
    header?: CardHeaderConfig;
    note?: string;
  },
): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      Buffer.byteLength(
        JSON.stringify(
          buildStructuredCard(text, {
            header: params.header,
            note: params.note,
            mentions: [
              ...(params.chunkMentions ?? []),
              ...(isFirst ? (params.firstChunkMentions ?? []) : []),
            ],
          }),
        ),
        "utf8",
      ),
  });
}

export async function sendStructuredCardFeishu(
  params: Omit<SendFeishuMessageParams, "preparedPostText"> & {
    header?: CardHeaderConfig;
    note?: string;
  },
): Promise<FeishuSendResult> {
  return sendCardFeishu({
    ...params,
    card: buildStructuredCard(params.text, params),
  });
}
