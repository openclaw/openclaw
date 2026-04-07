import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
import { encodeQuery, extractReplyText, isRecord, readString } from "./comment-shared.js";
import { normalizeCommentFileType, type CommentFileType } from "./comment-target.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_COMMENT_VERIFY_TIMEOUT_MS = 3_000;
const FEISHU_COMMENT_REPLY_PAGE_SIZE = 100;
const FEISHU_COMMENT_REPLY_PAGE_LIMIT = 5;
const FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS = 1_000;
const FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT = 6;

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
  waitMs?: (ms: number) => Promise<void>;
};

export type ResolvedDriveCommentEventTurn = {
  eventId: string;
  messageId: string;
  commentId: string;
  replyId?: string;
  noticeType: "add_comment" | "add_reply";
  fileToken: string;
  fileType: CommentFileType;
  isWholeComment?: boolean;
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
  log_id?: string;
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
  is_whole?: boolean;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      error: formatErrorMessage(error),
    });
  }
}

function summarizeCommentRepliesForLog(replies: FeishuDriveCommentReply[]): string {
  return safeJsonStringify(
    replies.map((reply) => ({
      reply_id: reply.reply_id,
      text_len: extractReplyText(reply)?.length ?? 0,
    })),
  );
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  const formatErrorDetails = (error: unknown): string => {
    if (!isRecord(error)) {
      return typeof error === "string" ? error : JSON.stringify(error);
    }
    const response = isRecord(error.response) ? error.response : undefined;
    const responseData = isRecord(response?.data) ? response?.data : undefined;
    const details = {
      message:
        typeof error.message === "string"
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error),
      code: readString(error.code),
      method: readString(isRecord(error.config) ? error.config.method : undefined),
      url: readString(isRecord(error.config) ? error.config.url : undefined),
      http_status: typeof response?.status === "number" ? response.status : undefined,
      feishu_code:
        typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
      feishu_msg: readString(responseData?.msg),
      feishu_log_id: readString(responseData?.log_id),
    };
    return safeJsonStringify(details);
  };

  const result = await raceWithTimeoutAndAbort(
    params.client.request({
      method: params.method,
      url: params.url,
      data: params.data ?? {},
      timeout: params.timeoutMs,
    }),
    { timeoutMs: params.timeoutMs },
  )
    .then((resolved) => (resolved.status === "resolved" ? resolved.value : null))
    .catch((error) => {
      params.logger?.(`${params.errorLabel}: ${formatErrorDetails(error)}`);
      return null;
    });
  if (!result) {
    params.logger?.(`${params.errorLabel}: request timed out or returned no data`);
  }
  return result;
}

async function fetchDriveCommentReplies(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<{ replies: FeishuDriveCommentReply[]; logIds: string[] }> {
  const replies: FeishuDriveCommentReply[] = [];
  const logIds: string[] = [];
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
    if (response?.log_id?.trim()) {
      logIds.push(response.log_id.trim());
    }
    if (response?.code !== 0) {
      if (response) {
        params.logger?.(
          `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}: ` +
            `${response.msg ?? "unknown error"} ` +
            `log_id=${response.log_id?.trim() || "unknown"}`,
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
  return { replies, logIds };
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
  waitMs: (ms: number) => Promise<void>;
}): Promise<{
  documentTitle?: string;
  documentUrl?: string;
  isWholeComment?: boolean;
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
      ? (commentResponse.data?.items ?? []).find(
          (item) => item.comment_id?.trim() === params.commentId,
        )
      : undefined;
  const embeddedReplies = commentCard?.reply_list?.replies ?? [];
  params.logger?.(
    `feishu[${params.accountId}]: embedded comment replies comment=${params.commentId} ` +
      `count=${embeddedReplies.length} summary=${summarizeCommentRepliesForLog(embeddedReplies)}`,
  );
  const embeddedTargetReply = params.replyId
    ? embeddedReplies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : embeddedReplies.at(-1);

  let replies = embeddedReplies;
  let fetchedMatchedReply = params.replyId
    ? replies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : undefined;
  if (!embeddedTargetReply || replies.length === 0) {
    params.logger?.(
      `feishu[${params.accountId}]: fetching extra comment replies comment=${params.commentId} ` +
        `requested_reply=${params.replyId ?? "none"} ` +
        `embedded_count=${embeddedReplies.length} ` +
        `embedded_hit=${embeddedTargetReply ? "yes" : "no"}`,
    );
    const fetched = await fetchDriveCommentReplies(params);
    if (fetched.replies.length > 0) {
      params.logger?.(
        `feishu[${params.accountId}]: fetched extra comment replies comment=${params.commentId} ` +
          `count=${fetched.replies.length} ` +
          `log_ids=${safeJsonStringify(fetched.logIds)} ` +
          `summary=${summarizeCommentRepliesForLog(fetched.replies)}`,
      );
      replies = fetched.replies;
      fetchedMatchedReply = params.replyId
        ? replies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
        : undefined;
    }
    if (params.replyId && !embeddedTargetReply && !fetchedMatchedReply) {
      for (let attempt = 1; attempt <= FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT; attempt += 1) {
        params.logger?.(
          `feishu[${params.accountId}]: retrying comment reply lookup comment=${params.commentId} ` +
            `requested_reply=${params.replyId} attempt=${attempt}/${FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT} ` +
            `delay_ms=${FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS}`,
        );
        await params.waitMs(FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS);
        const retried = await fetchDriveCommentReplies(params);
        if (retried.replies.length > 0) {
          params.logger?.(
            `feishu[${params.accountId}]: fetched retried comment replies comment=${params.commentId} ` +
              `attempt=${attempt} count=${retried.replies.length} ` +
              `log_ids=${safeJsonStringify(retried.logIds)} ` +
              `summary=${summarizeCommentRepliesForLog(retried.replies)}`,
          );
          replies = retried.replies;
        }
        fetchedMatchedReply = replies.find((reply) => reply.reply_id?.trim() === params.replyId);
        if (fetchedMatchedReply) {
          break;
        }
      }
    }
  }

  const rootReply = replies[0] ?? embeddedReplies[0];
  const targetReply = params.replyId
    ? (embeddedTargetReply ?? fetchedMatchedReply ?? undefined)
    : (replies.at(-1) ?? embeddedTargetReply ?? rootReply);
  const matchSource = params.replyId
    ? embeddedTargetReply
      ? "embedded"
      : fetchedMatchedReply
        ? "fetched"
        : "miss"
    : targetReply === rootReply
      ? "fallback_root"
      : targetReply === embeddedTargetReply
        ? "embedded_latest"
        : "fetched_latest";
  params.logger?.(
    `feishu[${params.accountId}]: comment reply resolution comment=${params.commentId} ` +
      `requested_reply=${params.replyId ?? "none"} match_source=${matchSource} ` +
      `root=${safeJsonStringify({ reply_id: rootReply?.reply_id, text_len: extractReplyText(rootReply)?.length ?? 0 })} ` +
      `target=${safeJsonStringify({ reply_id: targetReply?.reply_id, text_len: extractReplyText(targetReply)?.length ?? 0 })}`,
  );
  const meta = metaResponse?.code === 0 ? metaResponse.data?.metas?.[0] : undefined;

  return {
    documentTitle: meta?.title?.trim() || undefined,
    documentUrl: meta?.url?.trim() || undefined,
    isWholeComment: commentCard?.is_whole,
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
  isWholeComment?: boolean;
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
  if (params.isWholeComment === true) {
    lines.push("This is a whole-document comment.");
  }
  if (params.replyId?.trim()) {
    lines.push(`reply_id: ${params.replyId.trim()}`);
  }
  lines.push(
    "This is a Feishu document comment-thread event, not a Feishu IM conversation. Your final text reply will be posted automatically to the current comment thread and will not be sent as an instant message.",
    "If you need to inspect or handle the comment thread, prefer the feishu_drive tools: use list_comments / list_comment_replies to inspect comments, and use reply_comment/add_comment to notify the user after modifying the document.",
    "Whole-document comments do not support direct replies. When the current comment is whole-document, use feishu_drive.add_comment for any user-visible follow-up instead of reply_comment.",
    'If the comment asks you to modify document content, such as adding, inserting, replacing, or deleting text, tables, or headings, you must first use feishu_doc to actually modify the document. Do not reply with only "done", "I\'ll handle it", or a restated plan without calling tools.',
    'If the comment quotes document content, that quoted text is usually the edit anchor. For requests like "insert xxx below this content", first locate the position around the quoted content, then use feishu_doc to make the change.',
    'If the comment asks you to summarize, explain, rewrite, translate, refine, continue, or review the document content "below", "above", "this paragraph", "this section", or the quoted content, you must also treat the quoted content as the primary target anchor instead of defaulting to the whole document.',
    'For requests like "summarize the content below", "explain this section", or "continue writing from here", first locate the relevant document fragment based on the comment\'s quoted content. If the quote is not sufficient to support the answer, then use feishu_doc.read or feishu_doc.list_blocks to read nearby context.',
    "Do not guess document content based only on the comment text, and do not output a vague summary before reading enough context. Unless the user explicitly asks to summarize the entire document, default to handling only the local scope related to the quoted content.",
    "When document edits are involved, first use feishu_doc.read or feishu_doc.list_blocks to confirm the context, then use feishu_doc writing or updating capabilities to complete the change. After the edit succeeds, notify the user through feishu_drive.reply_comment.",
    "If the document edit fails or you cannot locate the anchor, do not pretend it succeeded. Reply clearly in the comment thread with the reason for failure or the missing information.",
    "If this is a reading-comprehension task, such as summarization, explanation, or extraction, you may directly output the final answer text after confirming the context. The system will automatically reply with that answer in the current comment thread.",
    "Prefer plain text suitable for a comment thread. Unless the user explicitly asks for Markdown, do not use Markdown headings, bullet lists, numbered lists, tables, blockquotes, or fenced code blocks in the final reply.",
    "If source content was read in Markdown form, rewrite it into normal plain-text prose before replying in the comment thread instead of copying Markdown syntax through.",
    'Do not include internal reasoning, analysis, chain-of-thought, scratch work, or any "Reasoning:" / "Thinking:" section in a user-visible reply. Output only the final answer meant for the user, or NO_REPLY when appropriate.',
    'Do not narrate your plan or execution process in the user-visible reply. Avoid meta lead-ins such as "I will...", "I’ll first...", "I need to...", "The user wants...", "I have updated...", or "I am going to...".',
    "When the task is complete, reply only with the user-facing result itself, such as the final answer or a concise completion confirmation. Do not include preambles about what you plan to do next.",
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
  isWholeComment?: boolean;
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
    waitMs = delayMs,
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
    waitMs,
  });
  return {
    eventId,
    commentId,
    replyId,
    noticeType,
    fileToken,
    fileType,
    isWholeComment: context.isWholeComment,
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
    isWholeComment: resolved.isWholeComment,
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
    isWholeComment: resolved.isWholeComment,
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
