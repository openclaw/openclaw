import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
import { normalizeCommentFileType, type CommentFileType } from "./comment-target.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_COMMENT_VERIFY_TIMEOUT_MS = 3_000;
const FEISHU_COMMENT_REPLY_PAGE_SIZE = 200;
const FEISHU_COMMENT_REPLY_PAGE_LIMIT = 5;

type FeishuDriveCommentUserId = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
};

export type FeishuDriveCommentNoticeEvent = {
  comment_id?: string;
  event_id?: string;
  is_mentioned?: boolean;
  notice_meta?: {
    file_token?: string;
    file_type?: string;
    from_user_id?: FeishuDriveCommentUserId;
    notice_type?: string;
    to_user_id?: FeishuDriveCommentUserId;
  };
  reply_id?: string;
  timestamp?: string;
  type?: string;
};

type ResolveDriveCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
  createClient?: (account: ResolvedFeishuAccount) => FeishuRequestClient;
  verificationTimeoutMs?: number;
  logger?: (message: string) => void;
};

export type ResolvedDriveCommentEventTurn = {
  eventId: string;
  messageId: string;
  commentId: string;
  replyId?: string;
  noticeType: "add_comment" | "add_reply";
  fileToken: string;
  fileType: CommentFileType;
  senderId: string;
  senderUserId?: string;
  timestamp?: string;
  isMentioned?: boolean;
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
  prompt: string;
  preview: string;
};

type FeishuRequestClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "GET" | "POST";
    url: string;
    data: unknown;
    timeout: number;
  }): Promise<unknown>;
};

type FeishuOpenApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type FeishuDriveMetaBatchQueryResponse = FeishuOpenApiResponse<{
  metas?: Array<{
    doc_token?: string;
    title?: string;
    url?: string;
  }>;
}>;

type FeishuDriveCommentReply = {
  reply_id?: string;
  content?: {
    elements?: unknown[];
  };
};

type FeishuDriveCommentCard = {
  comment_id?: string;
  quote?: string;
  reply_list?: {
    replies?: FeishuDriveCommentReply[];
  };
};

type FeishuDriveCommentBatchQueryResponse = FeishuOpenApiResponse<{
  items?: FeishuDriveCommentCard[];
}>;

type FeishuDriveCommentRepliesListResponse = FeishuOpenApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentReply[];
  page_token?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function encodeQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) {
      query.set(key, trimmed);
    }
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

function buildDriveCommentTargetUrl(params: {
  fileToken: string;
  fileType: CommentFileType;
}): string {
  return (
    `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments/batch_query` +
    encodeQuery({
      file_type: params.fileType,
      user_id_type: "open_id",
    })
  );
}

function buildDriveCommentRepliesUrl(params: {
  fileToken: string;
  commentId: string;
  fileType: CommentFileType;
  pageToken?: string;
}): string {
  return (
    `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments/${encodeURIComponent(
      params.commentId,
    )}/replies` +
    encodeQuery({
      file_type: params.fileType,
      page_token: params.pageToken,
      page_size: String(FEISHU_COMMENT_REPLY_PAGE_SIZE),
      user_id_type: "open_id",
    })
  );
}

async function requestFeishuOpenApi<T>(params: {
  client: FeishuRequestClient;
  method: "GET" | "POST";
  url: string;
  data?: unknown;
  timeoutMs: number;
  logger?: (message: string) => void;
  errorLabel: string;
}): Promise<T | null> {
  const result = await raceWithTimeoutAndAbort(
    params.client.request({
      method: params.method,
      url: params.url,
      data: params.data ?? {},
      timeout: params.timeoutMs,
    }) as Promise<T>,
    { timeoutMs: params.timeoutMs },
  )
    .then((resolved) => (resolved.status === "resolved" ? resolved.value : null))
    .catch((error) => {
      params.logger?.(`${params.errorLabel}: ${String(error)}`);
      return null;
    });
  if (!result) {
    params.logger?.(`${params.errorLabel}: request timed out or returned no data`);
  }
  return result;
}

function extractCommentElementText(element: unknown): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const type = readString(element.type)?.trim();
  if (type === "text_run" && isRecord(element.text_run)) {
    return (
      readString(element.text_run.content)?.trim() ||
      readString(element.text_run.text)?.trim() ||
      undefined
    );
  }
  if (type === "mention") {
    const mention = isRecord(element.mention) ? element.mention : undefined;
    const mentionName =
      readString(mention?.name)?.trim() ||
      readString(mention?.display_name)?.trim() ||
      readString(element.name)?.trim();
    return mentionName ? `@${mentionName}` : "@mention";
  }
  if (type === "docs_link") {
    const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
    return (
      readString(docsLink?.text)?.trim() ||
      readString(docsLink?.url)?.trim() ||
      readString(element.text)?.trim() ||
      readString(element.url)?.trim() ||
      undefined
    );
  }
  return (
    readString(element.text)?.trim() ||
    readString(element.content)?.trim() ||
    readString(element.name)?.trim() ||
    undefined
  );
}

function extractReplyText(reply: FeishuDriveCommentReply | undefined): string | undefined {
  if (!reply || !isRecord(reply.content)) {
    return undefined;
  }
  const elements = Array.isArray(reply.content.elements) ? reply.content.elements : [];
  const text = elements
    .map(extractCommentElementText)
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("")
    .trim();
  return text || undefined;
}

async function fetchDriveCommentReplies(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<FeishuDriveCommentReply[]> {
  const replies: FeishuDriveCommentReply[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < FEISHU_COMMENT_REPLY_PAGE_LIMIT; page += 1) {
    const response = await requestFeishuOpenApi<FeishuDriveCommentRepliesListResponse>({
      client: params.client,
      method: "GET",
      url: buildDriveCommentRepliesUrl({
        fileToken: params.fileToken,
        commentId: params.commentId,
        fileType: params.fileType,
        pageToken,
      }),
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}`,
    });
    if (response?.code !== 0) {
      if (response) {
        params.logger?.(
          `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}: ${response.msg ?? "unknown error"}`,
        );
      }
      break;
    }
    replies.push(...(response.data?.items ?? []));
    if (response.data?.has_more !== true || !response.data.page_token?.trim()) {
      break;
    }
    pageToken = response.data.page_token.trim();
  }
  return replies;
}

async function fetchDriveCommentContext(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  replyId?: string;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<{
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
}> {
  const [metaResponse, commentResponse] = await Promise.all([
    requestFeishuOpenApi<FeishuDriveMetaBatchQueryResponse>({
      client: params.client,
      method: "POST",
      url: "/open-apis/drive/v1/metas/batch_query",
      data: {
        request_docs: [{ doc_token: params.fileToken, doc_type: params.fileType }],
        with_url: true,
      },
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch drive metadata for ${params.fileToken}`,
    }),
    requestFeishuOpenApi<FeishuDriveCommentBatchQueryResponse>({
      client: params.client,
      method: "POST",
      url: buildDriveCommentTargetUrl({
        fileToken: params.fileToken,
        fileType: params.fileType,
      }),
      data: {
        comment_ids: [params.commentId],
      },
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch drive comment ${params.commentId}`,
    }),
  ]);

  const commentCard =
    commentResponse?.code === 0
      ? ((commentResponse.data?.items ?? []).find(
          (item) => item.comment_id?.trim() === params.commentId,
        ) ?? commentResponse.data?.items?.[0])
      : undefined;
  const embeddedReplies = commentCard?.reply_list?.replies ?? [];
  const embeddedTargetReply = params.replyId
    ? embeddedReplies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : embeddedReplies.at(-1);

  let replies = embeddedReplies;
  if (!embeddedTargetReply || replies.length === 0) {
    const fetchedReplies = await fetchDriveCommentReplies(params);
    if (fetchedReplies.length > 0) {
      replies = fetchedReplies;
    }
  }

  const rootReply = replies[0] ?? embeddedReplies[0];
  const fetchedMatchedReply = params.replyId
    ? replies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : undefined;
  const targetReply = params.replyId
    ? (embeddedTargetReply ?? fetchedMatchedReply ?? undefined)
    : (replies.at(-1) ?? embeddedTargetReply ?? rootReply);
  const meta = metaResponse?.code === 0 ? metaResponse.data?.metas?.[0] : undefined;

  return {
    documentTitle: meta?.title?.trim() || undefined,
    documentUrl: meta?.url?.trim() || undefined,
    quoteText: commentCard?.quote?.trim() || undefined,
    rootCommentText: extractReplyText(rootReply),
    targetReplyText: extractReplyText(targetReply),
  };
}

function buildDriveCommentSurfacePrompt(params: {
  noticeType: "add_comment" | "add_reply";
  fileType: CommentFileType;
  fileToken: string;
  commentId: string;
  replyId?: string;
  isMentioned?: boolean;
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
}): string {
  const documentLabel = params.documentTitle
    ? `"${params.documentTitle}"`
    : `${params.fileType} document ${params.fileToken}`;
  const actionLabel = params.noticeType === "add_reply" ? "reply" : "comment";
  const firstLine = params.targetReplyText
    ? `The user added a ${actionLabel} in ${documentLabel}: ${params.targetReplyText}`
    : `The user added a ${actionLabel} in ${documentLabel}.`;
  const lines = [firstLine];
  if (
    params.noticeType === "add_reply" &&
    params.rootCommentText &&
    params.rootCommentText !== params.targetReplyText
  ) {
    lines.push(`Original comment: ${params.rootCommentText}`);
  }
  if (params.quoteText) {
    lines.push(`Quoted content: ${params.quoteText}`);
  }
  if (params.isMentioned === true) {
    lines.push("This comment mentioned you.");
  }
  if (params.documentUrl) {
    lines.push(`Document link: ${params.documentUrl}`);
  }
  lines.push(
    `Event type: ${params.noticeType}`,
    `file_token: ${params.fileToken}`,
    `file_type: ${params.fileType}`,
    `comment_id: ${params.commentId}`,
  );
  if (params.replyId?.trim()) {
    lines.push(`reply_id: ${params.replyId.trim()}`);
  }
  lines.push(
    "This is a Feishu document comment-thread event, not a Feishu IM conversation. Your final text reply will be posted automatically to the current comment thread and will not be sent as an instant message.",
    "If you need to inspect or handle the comment thread, prefer the feishu_drive tools: use list_comments / list_comment_replies to inspect comments, and use reply_comment/add_comment to notify the user after modifying the document.",
    'If the comment asks you to modify document content, such as adding, inserting, replacing, or deleting text, tables, or headings, you must first use feishu_doc to actually modify the document. Do not reply with only "done", "I\'ll handle it", or a restated plan without calling tools.',
    'If the comment quotes document content, that quoted text is usually the edit anchor. For requests like "insert xxx below this content", first locate the position around the quoted content, then use feishu_doc to make the change.',
    'If the comment asks you to summarize, explain, rewrite, translate, refine, continue, or review the document content "below", "above", "this paragraph", "this section", or the quoted content, you must also treat the quoted content as the primary target anchor instead of defaulting to the whole document.',
    'For requests like "summarize the content below", "explain this section", or "continue writing from here", first locate the relevant document fragment based on the comment\'s quoted content. If the quote is not sufficient to support the answer, then use feishu_doc.read or feishu_doc.list_blocks to read nearby context.',
    "Do not guess document content based only on the comment text, and do not output a vague summary before reading enough context. Unless the user explicitly asks to summarize the entire document, default to handling only the local scope related to the quoted content.",
    "When document edits are involved, first use feishu_doc.read or feishu_doc.list_blocks to confirm the context, then use feishu_doc writing or updating capabilities to complete the change. After the edit succeeds, notify the user through feishu_drive.reply_comment.",
    "If the document edit fails or you cannot locate the anchor, do not pretend it succeeded. Reply clearly in the comment thread with the reason for failure or the missing information.",
    "If this is a reading-comprehension task, such as summarization, explanation, or extraction, you may directly output the final answer text after confirming the context. The system will automatically reply with that answer in the current comment thread.",
    "When you produce a user-visible reply, keep it in the same language as the user's original comment or reply unless they explicitly ask for another language.",
    "If you have already completed the user-visible action through feishu_drive.reply_comment or feishu_drive.add_comment, output NO_REPLY at the end to avoid duplicate sending.",
    "If the user directly asks a question in the comment and a plain text answer is sufficient, output the answer text directly. The system will automatically reply with your final answer in the current comment thread.",
    "If you determine that the current comment does not require any user-visible action, output NO_REPLY at the end.",
  );
  lines.push(`Decide what to do next based on this document ${actionLabel} event.`);
  return lines.join("\n");
}

async function resolveDriveCommentEventCore(params: ResolveDriveCommentEventParams): Promise<{
  eventId: string;
  commentId: string;
  replyId?: string;
  noticeType: "add_comment" | "add_reply";
  fileToken: string;
  fileType: CommentFileType;
  senderId: string;
  senderUserId?: string;
  timestamp?: string;
  isMentioned?: boolean;
  context: {
    documentTitle?: string;
    documentUrl?: string;
    quoteText?: string;
    rootCommentText?: string;
    targetReplyText?: string;
  };
} | null> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    createClient = (account) => createFeishuClient(account) as FeishuRequestClient,
    verificationTimeoutMs = FEISHU_COMMENT_VERIFY_TIMEOUT_MS,
    logger,
  } = params;
  const eventId = event.event_id?.trim();
  const commentId = event.comment_id?.trim();
  const replyId = event.reply_id?.trim();
  const noticeType = event.notice_meta?.notice_type?.trim();
  const fileToken = event.notice_meta?.file_token?.trim();
  const fileType = normalizeCommentFileType(event.notice_meta?.file_type);
  const senderId = event.notice_meta?.from_user_id?.open_id?.trim();
  const senderUserId = event.notice_meta?.from_user_id?.user_id?.trim() || undefined;
  if (!eventId || !commentId || !noticeType || !fileToken || !fileType || !senderId) {
    logger?.(
      `feishu[${accountId}]: drive comment notice missing required fields event=${eventId ?? "unknown"} comment=${commentId ?? "unknown"}`,
    );
    return null;
  }
  if (noticeType !== "add_comment" && noticeType !== "add_reply") {
    logger?.(`feishu[${accountId}]: unsupported drive comment notice type ${noticeType}`);
    return null;
  }
  if (!botOpenId) {
    logger?.(
      `feishu[${accountId}]: skipping drive comment notice because bot open_id is unavailable ` +
        `event=${eventId}`,
    );
    return null;
  }
  if (senderId === botOpenId) {
    logger?.(
      `feishu[${accountId}]: ignoring self-authored drive comment notice event=${eventId} sender=${senderId}`,
    );
    return null;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const client = createClient(account);
  const context = await fetchDriveCommentContext({
    client,
    fileToken,
    fileType,
    commentId,
    replyId,
    timeoutMs: verificationTimeoutMs,
    logger,
    accountId,
  });
  return {
    eventId,
    commentId,
    replyId,
    noticeType,
    fileToken,
    fileType,
    senderId,
    senderUserId,
    timestamp: event.timestamp,
    isMentioned: event.is_mentioned,
    context,
  };
}

export function parseFeishuDriveCommentNoticeEventPayload(
  value: unknown,
): FeishuDriveCommentNoticeEvent | null {
  if (!isRecord(value) || !isRecord(value.notice_meta)) {
    return null;
  }
  const noticeMeta = value.notice_meta;
  const fromUserId = isRecord(noticeMeta.from_user_id) ? noticeMeta.from_user_id : undefined;
  const toUserId = isRecord(noticeMeta.to_user_id) ? noticeMeta.to_user_id : undefined;
  return {
    comment_id: readString(value.comment_id),
    event_id: readString(value.event_id),
    is_mentioned: readBoolean(value.is_mentioned),
    notice_meta: {
      file_token: readString(noticeMeta.file_token),
      file_type: readString(noticeMeta.file_type),
      from_user_id: fromUserId
        ? {
            open_id: readString(fromUserId.open_id),
            user_id: readString(fromUserId.user_id),
            union_id: readString(fromUserId.union_id),
          }
        : undefined,
      notice_type: readString(noticeMeta.notice_type),
      to_user_id: toUserId
        ? {
            open_id: readString(toUserId.open_id),
            user_id: readString(toUserId.user_id),
            union_id: readString(toUserId.union_id),
          }
        : undefined,
    },
    reply_id: readString(value.reply_id),
    timestamp: readString(value.timestamp),
    type: readString(value.type),
  };
}

export async function resolveDriveCommentEventTurn(
  params: ResolveDriveCommentEventParams,
): Promise<ResolvedDriveCommentEventTurn | null> {
  const resolved = await resolveDriveCommentEventCore(params);
  if (!resolved) {
    return null;
  }
  const prompt = buildDriveCommentSurfacePrompt({
    noticeType: resolved.noticeType,
    fileType: resolved.fileType,
    fileToken: resolved.fileToken,
    commentId: resolved.commentId,
    replyId: resolved.replyId,
    isMentioned: resolved.isMentioned,
    documentTitle: resolved.context.documentTitle,
    documentUrl: resolved.context.documentUrl,
    quoteText: resolved.context.quoteText,
    rootCommentText: resolved.context.rootCommentText,
    targetReplyText: resolved.context.targetReplyText,
  });
  const preview = prompt.replace(/\s+/g, " ").slice(0, 160);
  return {
    eventId: resolved.eventId,
    messageId: `drive-comment:${resolved.eventId}`,
    commentId: resolved.commentId,
    replyId: resolved.replyId,
    noticeType: resolved.noticeType,
    fileToken: resolved.fileToken,
    fileType: resolved.fileType,
    senderId: resolved.senderId,
    senderUserId: resolved.senderUserId,
    timestamp: resolved.timestamp,
    isMentioned: resolved.isMentioned,
    documentTitle: resolved.context.documentTitle,
    documentUrl: resolved.context.documentUrl,
    quoteText: resolved.context.quoteText,
    rootCommentText: resolved.context.rootCommentText,
    targetReplyText: resolved.context.targetReplyText,
    prompt,
    preview,
  };
}
