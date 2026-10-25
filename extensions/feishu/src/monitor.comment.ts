import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asBoolean as readBoolean,
  isRecord,
  normalizeOptionalString as normalizeString,
  normalizeTrimmedStringList,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { raceWithTimeoutAndAbort, waitForAbortableDelay } from "./async.js";
import { createFeishuClient } from "./client.js";
import {
  encodeQuery,
  formatFeishuApiError,
  parseCommentContentElements,
  type FeishuDriveCommentCard,
  type FeishuDriveCommentReply,
  type ParsedCommentContent,
  type ParsedCommentLinkedDocument,
} from "./comment-shared.js";
import { normalizeCommentFileType, type CommentFileType } from "./comment-target.js";

const FEISHU_COMMENT_VERIFY_TIMEOUT_MS = 3_000;
const FEISHU_COMMENT_PAGE_SIZE = 100;
const FEISHU_COMMENT_PAGE_LIMIT = 5;
const FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS = 1_000;
const FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT = 6;
const FEISHU_COMMENT_THREAD_PROMPT_LIMIT = 20;
const FEISHU_WHOLE_COMMENT_PROMPT_LIMIT = 12;
const FEISHU_PROMPT_TEXT_LIMIT = 220;

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
  logger?: (message: string) => void;
  abortSignal?: AbortSignal;
};

type FeishuRequestClient = ReturnType<typeof createFeishuClient>;

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

type FeishuDriveCommentBatchQueryResponse = FeishuOpenApiResponse<{
  items?: FeishuDriveCommentCard[];
}>;

type FeishuDriveCommentPage<T> = FeishuOpenApiResponse<{
  has_more?: boolean;
  items?: T[];
  page_token?: string;
}>;

type ResolvedCommentReplyContext = {
  replyId?: string;
  userId?: string;
  createTime?: number;
  isBotAuthored: boolean;
  content: ParsedCommentContent;
};

type ResolvedWholeCommentTimelineEntry = {
  commentId: string;
  userId?: string;
  createTime?: number;
  isBotAuthored: boolean;
  content: ParsedCommentContent;
};

function truncatePromptText(text: string | undefined): string {
  const normalized = normalizeString(text);
  if (!normalized) {
    return "";
  }
  return normalized.length > FEISHU_PROMPT_TEXT_LIMIT
    ? `${sliceUtf16Safe(normalized, 0, FEISHU_PROMPT_TEXT_LIMIT - 1)}…`
    : normalized;
}

function formatPromptTextValue(text: string | undefined): string {
  return JSON.stringify(truncatePromptText(text));
}

function compareCommentTimelineEntries<T extends { createTime?: number }>(
  left: T,
  right: T,
  stableId: (entry: T) => string | undefined,
): number {
  const leftTime = left.createTime ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.createTime ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (stableId(left) ?? "").localeCompare(stableId(right) ?? "");
}

function formatLinkedDocumentsInlineSummary(
  linkedDocuments: ParsedCommentLinkedDocument[],
): string {
  if (linkedDocuments.length === 0) {
    return "none";
  }
  return linkedDocuments
    .map(
      (link) =>
        `${link.resolvedObjType ?? link.urlKind}:${link.resolvedObjToken ?? link.wikiNodeToken ?? "UNKNOWN"}`,
    )
    .join(",");
}

type CommentContentContext = {
  botOpenIds?: Iterable<string | undefined>;
  currentDocument: {
    fileType: CommentFileType;
    fileToken: string;
  };
  client: FeishuRequestClient;
  wikiCache: Map<
    string,
    Promise<{
      resolvedObjType?: CommentFileType;
      resolvedObjToken?: string;
    } | null>
  >;
  logger?: (message: string) => void;
  accountId: string;
};

async function resolveParsedCommentContent(
  params: CommentContentContext & { elements?: unknown[] },
): Promise<ParsedCommentContent> {
  const parsed = parseCommentContentElements({
    elements: params.elements,
    botOpenIds: params.botOpenIds,
    currentDocument: params.currentDocument,
  });
  if (!parsed.linkedDocuments.some((link) => link.urlKind === "wiki" && link.wikiNodeToken)) {
    return parsed;
  }

  const resolvedLinkedDocuments = await Promise.all(
    parsed.linkedDocuments.map(async (link) => {
      if (link.urlKind !== "wiki" || !link.wikiNodeToken) {
        return link;
      }
      let pending = params.wikiCache.get(link.wikiNodeToken);
      if (!pending) {
        pending = params.client.wiki.space
          .getNode({
            params: {
              token: link.wikiNodeToken,
            },
          })
          .then((response) => {
            if (response.code !== 0) {
              params.logger?.(
                `feishu[${params.accountId}]: wiki link resolution failed token=${link.wikiNodeToken} ` +
                  `code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"}`,
              );
              return null;
            }
            const objType = normalizeCommentFileType(response.data?.node?.obj_type);
            const objToken = normalizeString(response.data?.node?.obj_token);
            if (!objType || !objToken) {
              return null;
            }
            return {
              resolvedObjType: objType,
              resolvedObjToken: objToken,
            };
          })
          .catch((error: unknown) => {
            params.logger?.(
              `feishu[${params.accountId}]: wiki link resolution threw token=${link.wikiNodeToken} error=${formatErrorMessage(error)}`,
            );
            return null;
          });
        params.wikiCache.set(link.wikiNodeToken, pending);
      }
      const resolved = await pending;
      if (!resolved) {
        return link;
      }
      return {
        ...link,
        resolvedObjType: resolved.resolvedObjType,
        resolvedObjToken: resolved.resolvedObjToken,
        isCurrentDocument:
          resolved.resolvedObjType === params.currentDocument.fileType &&
          resolved.resolvedObjToken === params.currentDocument.fileToken,
      };
    }),
  );

  return {
    ...parsed,
    linkedDocuments: resolvedLinkedDocuments,
  };
}

type DriveCommentPageRequest = {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
};

type DriveCommentPageTarget = { kind: "whole-comments" } | { kind: "replies"; commentId: string };

type DriveCommentPageItem = {
  "whole-comments": FeishuDriveCommentCard;
  replies: FeishuDriveCommentReply;
};

async function fetchDriveCommentPages<T extends DriveCommentPageTarget>(
  params: DriveCommentPageRequest & T,
): Promise<DriveCommentPageItem[T["kind"]][]> {
  const errorLabel =
    params.kind === "whole-comments"
      ? `feishu[${params.accountId}]: failed to list drive comments for ${params.fileToken}`
      : `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}`;
  const items: DriveCommentPageItem[T["kind"]][] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < FEISHU_COMMENT_PAGE_LIMIT; page += 1) {
    const commentsUrl = `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments`;
    const url =
      params.kind === "whole-comments"
        ? commentsUrl
        : `${commentsUrl}/${encodeURIComponent(params.commentId)}/replies`;
    const query = {
      file_type: params.fileType,
      ...(params.kind === "whole-comments" ? { is_whole: "true" } : {}),
      page_size: String(FEISHU_COMMENT_PAGE_SIZE),
      page_token: pageToken,
      user_id_type: "open_id",
    };
    const response = await requestFeishuOpenApi<
      FeishuDriveCommentPage<DriveCommentPageItem[T["kind"]]>
    >({
      ...params,
      method: "GET",
      url: url + encodeQuery(query),
      errorLabel,
    });
    if (response?.code !== 0) {
      if (response) {
        params.logger?.(
          `${errorLabel}: ${response.msg ?? "unknown error"} log_id=${response.log_id?.trim() || "unknown"}`,
        );
      }
      break;
    }
    items.push(...(response.data?.items ?? []));
    if (response.data?.has_more !== true || !response.data.page_token?.trim()) {
      break;
    }
    pageToken = response.data.page_token.trim();
  }
  return items;
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
    params.client.request<T>({
      method: params.method,
      url: params.url,
      data: params.data ?? {},
      timeout: params.timeoutMs,
    }),
    { timeoutMs: params.timeoutMs },
  )
    .then((resolved) => (resolved.status === "resolved" ? resolved.value : null))
    .catch((error: unknown) => {
      params.logger?.(`${params.errorLabel}: ${formatFeishuApiError(error)}`);
      return null;
    });
  if (!result) {
    params.logger?.(`${params.errorLabel}: request timed out or returned no data`);
  }
  return result;
}

function selectNearbyEntries<T>(
  entries: T[],
  currentIndex: number,
  selected: Set<number>,
  limit: number,
): T[] {
  for (let radius = 1; selected.size < limit; radius += 1) {
    const before = currentIndex - radius;
    const after = currentIndex + radius;
    if (before >= 0) {
      selected.add(before);
    }
    if (selected.size >= limit) {
      break;
    }
    if (after < entries.length) {
      selected.add(after);
    }
    if (before < 0 && after >= entries.length) {
      break;
    }
  }
  return [...selected]
    .toSorted((left, right) => left - right)
    .map((index) => entries[index])
    .filter((entry): entry is T => Boolean(entry));
}

function findNearestBotTimelineEntry(params: {
  entries: ResolvedWholeCommentTimelineEntry[];
  currentIndex: number;
  direction: "before" | "after";
}): ResolvedWholeCommentTimelineEntry | undefined {
  const step = params.direction === "after" ? 1 : -1;
  for (
    let index = params.currentIndex + step;
    index >= 0 && index < params.entries.length;
    index += step
  ) {
    const candidate = params.entries[index];
    if (candidate?.isBotAuthored) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveDriveCommentEventTurn(params: ResolveDriveCommentEventParams) {
  const { cfg, accountId, event, botOpenId, logger, abortSignal } = params;
  const eventId = event.event_id?.trim();
  const commentId = event.comment_id?.trim();
  const replyId = event.reply_id?.trim();
  const noticeType = event.notice_meta?.notice_type?.trim();
  const fileToken = event.notice_meta?.file_token?.trim();
  const fileType = normalizeCommentFileType(event.notice_meta?.file_type);
  const senderId = event.notice_meta?.from_user_id?.open_id?.trim();
  const senderUserId = normalizeString(event.notice_meta?.from_user_id?.user_id);
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
  const configuredBotOpenId = botOpenId?.trim();
  const eventRecipientBotOpenId = event.notice_meta?.to_user_id?.open_id?.trim();
  // Mentioned comment notices identify their recipient even when the startup
  // identity probe is unavailable. Keep this fallback event-local so an
  // unverified envelope can never seed process or persisted bot identity.
  const effectiveBotOpenId =
    configuredBotOpenId || (event.is_mentioned === true ? eventRecipientBotOpenId : undefined);
  if (!effectiveBotOpenId) {
    logger?.(
      `feishu[${accountId}]: skipping drive comment notice because bot open_id is unavailable ` +
        `event=${eventId}`,
    );
    return null;
  }
  if (senderId === effectiveBotOpenId) {
    logger?.(
      `feishu[${accountId}]: ignoring self-authored drive comment notice event=${eventId} sender=${senderId}`,
    );
    return null;
  }

  const client = createFeishuClient(
    (await import("./accounts.js")).resolveFeishuAccount({ cfg, accountId }),
  );
  const botOpenIds = [effectiveBotOpenId, event.notice_meta?.to_user_id?.open_id];
  const pageRequest: DriveCommentPageRequest = {
    client,
    fileToken,
    fileType,
    timeoutMs: FEISHU_COMMENT_VERIFY_TIMEOUT_MS,
    logger,
    accountId,
  };
  const fetchDriveCommentContext = async () => {
    const [metaResponse, commentResponse] = await Promise.all([
      requestFeishuOpenApi<FeishuDriveMetaBatchQueryResponse>({
        client,
        method: "POST",
        url: "/open-apis/drive/v1/metas/batch_query",
        data: {
          request_docs: [{ doc_token: fileToken, doc_type: fileType }],
          with_url: true,
        },
        timeoutMs: pageRequest.timeoutMs,
        logger,
        errorLabel: `feishu[${accountId}]: failed to fetch drive metadata for ${fileToken}`,
      }),
      requestFeishuOpenApi<FeishuDriveCommentBatchQueryResponse>({
        client,
        method: "POST",
        url:
          `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/batch_query` +
          encodeQuery({ file_type: fileType, user_id_type: "open_id" }),
        data: {
          comment_ids: [commentId],
        },
        timeoutMs: pageRequest.timeoutMs,
        logger,
        errorLabel: `feishu[${accountId}]: failed to fetch drive comment ${commentId}`,
      }),
    ]);
    const wikiCache: CommentContentContext["wikiCache"] = new Map();

    const commentCard =
      commentResponse?.code === 0
        ? (commentResponse.data?.items ?? []).find((item) => item.comment_id?.trim() === commentId)
        : undefined;
    const embeddedReplies = commentCard?.reply_list?.replies ?? [];
    const embeddedTargetReply = replyId
      ? embeddedReplies.find((reply) => reply.reply_id?.trim() === replyId)
      : embeddedReplies.at(-1);

    let replies = embeddedReplies;
    let fetchedMatchedReply = replyId ? embeddedTargetReply : undefined;
    const needsExtraReplies = !embeddedTargetReply || commentCard?.has_more === true;
    if (needsExtraReplies) {
      const fetched = await fetchDriveCommentPages({ ...pageRequest, commentId, kind: "replies" });
      if (fetched.length > 0) {
        replies = fetched;
        fetchedMatchedReply = replyId
          ? replies.find((reply) => reply.reply_id?.trim() === replyId)
          : undefined;
      }
      if (replyId && !embeddedTargetReply && !fetchedMatchedReply) {
        for (let attempt = 1; attempt <= FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT; attempt += 1) {
          if (abortSignal?.aborted) {
            break;
          }
          logger?.(
            `feishu[${accountId}]: retrying comment reply lookup comment=${commentId} ` +
              `requested_reply=${replyId} attempt=${attempt}/${FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT} ` +
              `delay_ms=${FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS}`,
          );
          const delayElapsed = await waitForAbortableDelay(
            FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS,
            abortSignal,
          );
          if (!delayElapsed) {
            break;
          }
          const retried = await fetchDriveCommentPages({
            ...pageRequest,
            commentId,
            kind: "replies",
          });
          if (retried.length > 0) {
            replies = retried;
          }
          fetchedMatchedReply = replies.find((reply) => reply.reply_id?.trim() === replyId);
          if (fetchedMatchedReply) {
            break;
          }
        }
      }
    }

    const rootReply = replies[0] ?? embeddedReplies[0];
    const targetReply = replyId
      ? (embeddedTargetReply ?? fetchedMatchedReply)
      : (replies.at(-1) ?? embeddedTargetReply ?? rootReply);
    const meta = metaResponse?.code === 0 ? metaResponse.data?.metas?.[0] : undefined;
    const currentDocument = {
      fileType,
      fileToken,
    };
    const contentContext: CommentContentContext = {
      botOpenIds,
      currentDocument,
      client,
      wikiCache,
      logger,
      accountId,
    };
    const normalizedBotOpenIds = new Set(normalizeTrimmedStringList(botOpenIds));
    const resolvedReplies = await Promise.all(
      replies.map(async (reply): Promise<ResolvedCommentReplyContext> => {
        const userId = normalizeString(reply.user_id);
        return {
          replyId: normalizeString(reply.reply_id),
          userId,
          createTime: typeof reply.create_time === "number" ? reply.create_time : undefined,
          isBotAuthored: userId !== undefined && normalizedBotOpenIds.has(userId),
          content: await resolveParsedCommentContent({
            ...contentContext,
            elements: isRecord(reply.content) ? reply.content.elements : undefined,
          }),
        };
      }),
    );
    resolvedReplies.sort((left, right) =>
      compareCommentTimelineEntries(left, right, (reply) => reply.replyId),
    );
    const rootReplyContext =
      resolvedReplies.find((reply) => reply.replyId === normalizeString(rootReply?.reply_id)) ??
      resolvedReplies[0];
    const targetReplyContext =
      resolvedReplies.find((reply) => reply.replyId === normalizeString(targetReply?.reply_id)) ??
      (replyId ? undefined : (resolvedReplies.at(-1) ?? rootReplyContext));

    let wholeCommentTimeline: ResolvedWholeCommentTimelineEntry[] = [];
    if (commentCard?.is_whole === true) {
      const allComments = await fetchDriveCommentPages({
        ...pageRequest,
        kind: "whole-comments",
      });
      const wholeComments = allComments.filter((comment) => comment.is_whole === true);
      wholeCommentTimeline = await Promise.all(
        wholeComments.map(async (comment) => {
          const rootWholeReply = comment.reply_list?.replies?.[0];
          const content = await resolveParsedCommentContent({
            ...contentContext,
            elements: isRecord(rootWholeReply?.content)
              ? rootWholeReply.content.elements
              : undefined,
          });
          const commentUserId =
            normalizeString(rootWholeReply?.user_id) || normalizeString(comment.user_id);
          return {
            commentId: normalizeString(comment.comment_id) ?? "",
            userId: commentUserId,
            createTime:
              typeof comment.create_time === "number"
                ? comment.create_time
                : typeof rootWholeReply?.create_time === "number"
                  ? rootWholeReply.create_time
                  : undefined,
            isBotAuthored: commentUserId !== undefined && normalizedBotOpenIds.has(commentUserId),
            content,
          };
        }),
      );
      wholeCommentTimeline = wholeCommentTimeline
        .filter((entry) => Boolean(entry.commentId))
        .toSorted((left, right) =>
          compareCommentTimelineEntries(left, right, (entry) => entry.commentId),
        );
    }

    const currentWholeCommentIndex = wholeCommentTimeline.findIndex(
      (entry) => entry.commentId === commentId,
    );

    return {
      documentTitle: normalizeString(meta?.title),
      documentUrl: normalizeString(meta?.url),
      isWholeComment: commentCard?.is_whole,
      quoteText: normalizeString(commentCard?.quote),
      rootCommentText:
        rootReplyContext?.content.semanticText ?? rootReplyContext?.content.plainText,
      targetReplyText:
        targetReplyContext?.content.semanticText ?? targetReplyContext?.content.plainText,
      targetReplyContent: targetReplyContext?.content,
      currentCommentThreadReplies: resolvedReplies,
      wholeCommentTimeline,
      nearestBotWholeCommentAfter:
        currentWholeCommentIndex >= 0
          ? findNearestBotTimelineEntry({
              entries: wholeCommentTimeline,
              currentIndex: currentWholeCommentIndex,
              direction: "after",
            })
          : undefined,
      nearestBotWholeCommentBefore:
        currentWholeCommentIndex >= 0
          ? findNearestBotTimelineEntry({
              entries: wholeCommentTimeline,
              currentIndex: currentWholeCommentIndex,
              direction: "before",
            })
          : undefined,
    };
  };
  const context = await fetchDriveCommentContext();
  const documentLabel = context.documentTitle
    ? `"${context.documentTitle}"`
    : `${fileType} document ${fileToken}`;
  const actionLabel = noticeType === "add_reply" ? "reply" : "comment";
  const firstLine = `The user added a ${actionLabel} in ${documentLabel}.`;
  const lines = [firstLine];
  if (context.targetReplyText) {
    lines.push(`Current user comment text: ${formatPromptTextValue(context.targetReplyText)}`);
  }
  if (
    noticeType === "add_reply" &&
    context.rootCommentText &&
    context.rootCommentText !== context.targetReplyText
  ) {
    lines.push(`Original comment text: ${formatPromptTextValue(context.rootCommentText)}`);
  }
  if (context.quoteText) {
    lines.push(`Quoted content: ${formatPromptTextValue(context.quoteText)}`);
  }
  if (event.is_mentioned === true) {
    lines.push("This comment mentioned you.");
  }
  if (context.documentUrl) {
    lines.push(`Document link: ${context.documentUrl}`);
  }
  lines.push("Current commented document:", `- file_type=${fileType}`, `- file_token=${fileToken}`);
  if (context.documentTitle) {
    lines.push(`- title=${context.documentTitle}`);
  }
  if (context.documentUrl) {
    lines.push(`- url=${context.documentUrl}`);
  }
  lines.push(
    `Event type: ${noticeType}`,
    `file_token: ${fileToken}`,
    `file_type: ${fileType}`,
    `comment_id: ${commentId}`,
  );
  if (context.isWholeComment === true) {
    lines.push("This is a whole-document comment.");
  }
  if (replyId) {
    lines.push(`reply_id: ${replyId}`);
  }
  if (context.targetReplyContent?.semanticText) {
    lines.push(
      `Current user comment semantic text: ${formatPromptTextValue(
        context.targetReplyContent.semanticText,
      )}`,
    );
  }
  if (context.targetReplyContent?.botMentioned) {
    lines.push(
      "Bot routing mention detected in the current user comment. Treat that mention as routing only, not task content.",
    );
  }
  const nonBotMentions = (context.targetReplyContent?.mentions ?? [])
    .filter((mention) => !mention.isBotMention)
    .map((mention) => mention.displayText);
  if (nonBotMentions.length > 0) {
    lines.push(`Other mentioned users in current comment: ${nonBotMentions.join(", ")}`);
  }
  const linkedDocuments = context.targetReplyContent?.linkedDocuments ?? [];
  if (linkedDocuments.length > 0) {
    lines.push(
      "Referenced documents from current user comment:",
      ...linkedDocuments.map((link, index) => {
        const parts = [
          `raw_url=${link.rawUrl}`,
          `url_kind=${link.urlKind}`,
          link.wikiNodeToken ? `wiki_node_token=${link.wikiNodeToken}` : null,
          `resolved_type=${link.resolvedObjType ?? "UNKNOWN"}`,
          `resolved_token=${link.resolvedObjToken ?? "UNKNOWN"}`,
          `same_as_current_document=${link.isCurrentDocument === true ? "yes" : "no"}`,
        ].filter((part): part is string => Boolean(part));
        return `- [${index + 1}] ${parts.join(" ")}`;
      }),
    );
  }
  if (!context.isWholeComment && context.currentCommentThreadReplies.length > 0) {
    const replies = context.currentCommentThreadReplies;
    let promptReplies = replies;
    if (replies.length > FEISHU_COMMENT_THREAD_PROMPT_LIMIT) {
      const targetIndex = replies.findIndex((reply) => reply.replyId === replyId);
      const currentIndex = targetIndex >= 0 ? targetIndex : replies.length - 1;
      const selected = new Set<number>([0, currentIndex, replies.length - 1]);
      promptReplies = selectNearbyEntries(
        replies,
        currentIndex,
        selected,
        FEISHU_COMMENT_THREAD_PROMPT_LIMIT,
      );
    }
    lines.push(
      "Current comment card timeline (primary context for follow-ups on this comment card):",
      ...promptReplies.map((reply, index) => {
        const text = reply.content.semanticText ?? reply.content.plainText;
        return (
          `- [${index + 1}] author=${reply.isBotAuthored ? "assistant" : "user"} ` +
          `user_id=${reply.userId ?? "UNKNOWN"} ` +
          `reply_id=${reply.replyId ?? "UNKNOWN"} ` +
          `current_event=${reply.replyId === replyId ? "yes" : "no"} ` +
          `text=${formatPromptTextValue(text)} ` +
          `referenced_docs=${formatLinkedDocumentsInlineSummary(reply.content.linkedDocuments)}`
        );
      }),
      "For this non-whole comment, use the current comment card timeline above as the primary source for phrases like 'above', 'previous result', 'that summary', or 'insert it'.",
      "Document-level session history is auxiliary background only. Do not use another comment card's recent output as the primary referent.",
    );
  }
  if (context.isWholeComment && context.wholeCommentTimeline.length > 0) {
    const entries = context.wholeCommentTimeline;
    let promptEntries = entries;
    if (entries.length > FEISHU_WHOLE_COMMENT_PROMPT_LIMIT) {
      const currentIndex = entries.findIndex((entry) => entry.commentId === commentId);
      if (currentIndex < 0) {
        promptEntries = entries.slice(-FEISHU_WHOLE_COMMENT_PROMPT_LIMIT);
      } else {
        const selected = new Set<number>([currentIndex]);
        const nearestBotAfter = entries.findIndex(
          (entry, index) => index > currentIndex && entry.isBotAuthored,
        );
        if (nearestBotAfter >= 0) {
          selected.add(nearestBotAfter);
        }
        for (let index = currentIndex - 1; index >= 0; index -= 1) {
          if (entries[index]?.isBotAuthored) {
            selected.add(index);
            break;
          }
        }
        promptEntries = selectNearbyEntries(
          entries,
          currentIndex,
          selected,
          FEISHU_WHOLE_COMMENT_PROMPT_LIMIT,
        );
      }
    }
    lines.push(
      "Whole-document comment timeline (primary context for whole-comment follow-ups):",
      ...promptEntries.map((entry, index) => {
        const text = entry.content.semanticText ?? entry.content.plainText;
        return (
          `- [${index + 1}] create_time=${entry.createTime ?? "UNKNOWN"} ` +
          `comment_id=${entry.commentId} ` +
          `author=${entry.isBotAuthored ? "assistant" : "user"} ` +
          `user_id=${entry.userId ?? "UNKNOWN"} ` +
          `current_comment=${entry.commentId === commentId ? "yes" : "no"} ` +
          `text=${formatPromptTextValue(text)} ` +
          `referenced_docs=${formatLinkedDocumentsInlineSummary(entry.content.linkedDocuments)}`
        );
      }),
    );
    for (const [direction, entry] of [
      ["after", context.nearestBotWholeCommentAfter],
      ["before", context.nearestBotWholeCommentBefore],
    ] as const) {
      if (entry) {
        lines.push(
          `Nearest bot-authored whole-comment ${direction} the current comment: comment_id=${entry.commentId} text=${formatPromptTextValue(
            entry.content.semanticText ?? entry.content.plainText,
          )}`,
        );
      }
    }
    lines.push(
      "For this whole-document comment, use the whole-comment timeline above as the primary source for phrases like 'just now', 'previous result', 'that summary', or 'write it back'.",
      "Document-level session history is auxiliary background only. Do not resolve whole-comment follow-ups by blindly using the most recent document-session output.",
    );
  }
  lines.push(
    "This is a Feishu document comment thread.",
    "It is not a Feishu IM chat.",
    "Your final text reply will be posted to the current comment thread automatically.",
    "Use the thread timeline above as the main context for follow-up requests.",
    "Do not use another comment card or document-session output as the main reference.",
    "If you need comment thread context, use the available Feishu drive comment-list actions.",
    "If you modify the document, post a user-visible follow-up in the comment thread.",
    "Use an available Feishu drive reply-comment or add-comment action for that follow-up.",
    "Whole-document comments do not support direct replies.",
    "For whole-document comments, use the Feishu drive add-comment action when available.",
    'Only treat URLs listed under "Referenced documents from current user comment" as structured Feishu document references.',
    "URLs that appear only in comment text are plain links unless you verify them.",
    "If the user asks about a linked Feishu document or wiki page, treat that linked document as the read target.",
    "If the user asks you to use a linked document as guidance, treat the linked document as the reference source and the current commented document as the edit target.",
    "If a referenced document resolves to the same file_token and file_type as the current commented document, treat it as the current document.",
    "If the user asks you to modify document content, you must use an available Feishu document tool to make the change.",
    'Do not reply with only "done", "I\'ll handle it", or a restated plan without calling tools.',
    "If the comment quotes document content, treat the quoted content as the main anchor.",
    'For requests like "insert xxx below this content", locate the quoted content first, then edit the document.',
    'For requests like "summarize the content below", "explain this section", or "continue writing from here", use the quoted content as the main target.',
    "If the quote is not enough, use available Feishu document read or list-blocks actions to read nearby context.",
    "Do not guess document content from the comment alone.",
    "Do not give a vague answer before reading enough context.",
    "Unless the user asks for the whole document, handle only the local content around the quoted anchor.",
    "If document edits are involved, read the anchor first, then edit.",
    "If the edit fails or the anchor cannot be found, say so clearly.",
    "If this is a reading task, such as summarization, explanation, or extraction, you may output the final answer directly after confirming the context.",
    "Use the same language as the user's comment or reply, unless the user asks for another language.",
    "Use plain text only.",
    "Do not use Markdown.",
    "Do not use headings.",
    "Do not use bullet lists.",
    "Do not use numbered lists.",
    "Do not use tables.",
    "Do not use blockquotes.",
    "Do not use code blocks.",
    "Do not show reasoning.",
    "Do not show analysis.",
    "Do not show chain-of-thought.",
    "Do not show scratch work.",
    "Do not describe your plan.",
    "Do not describe your steps.",
    "Do not describe tool use.",
    'Do not start with phrases like "I will", "I’ll first", "I need to", "The user wants", or "I have updated".',
    "Output only the final user-facing reply.",
    "If you already sent the user-visible reply with a Feishu drive comment action, output exactly NO_REPLY.",
    "If no user-visible reply is needed, output exactly NO_REPLY.",
    "Be concise.",
    "Do not omit requested content.",
  );
  lines.push(
    "Choose one outcome: output the final plain-text reply, edit the document and then post a user-visible follow-up in the comment thread, or output exactly NO_REPLY.",
  );
  const prompt = lines.join("\n");
  return {
    eventId,
    messageId: `drive-comment:${eventId}`,
    commentId,
    replyId,
    fileToken,
    fileType,
    isWholeComment: context.isWholeComment,
    senderId,
    senderUserId,
    timestamp: event.timestamp,
    isMentioned: event.is_mentioned,
    documentTitle: context.documentTitle,
    documentUrl: context.documentUrl,
    quoteText: context.quoteText,
    rootCommentText: context.rootCommentText,
    targetReplyText: context.targetReplyText,
    prompt,
    preview: truncateUtf16Safe(prompt.replace(/\s+/g, " "), 160),
  };
}

export function parseFeishuDriveCommentNoticeEventPayload(
  value: unknown,
): FeishuDriveCommentNoticeEvent | null {
  if (!isRecord(value) || !isRecord(value.notice_meta)) {
    return null;
  }
  const noticeMeta = value.notice_meta;
  const readUserId = (userIdValue: unknown): FeishuDriveCommentUserId | undefined =>
    isRecord(userIdValue)
      ? {
          open_id: readString(userIdValue.open_id),
          user_id: readString(userIdValue.user_id),
          union_id: readString(userIdValue.union_id),
        }
      : undefined;
  return {
    comment_id: readString(value.comment_id),
    event_id: readString(value.event_id),
    is_mentioned: readBoolean(value.is_mentioned),
    notice_meta: {
      file_token: readString(noticeMeta.file_token),
      file_type: readString(noticeMeta.file_type),
      from_user_id: readUserId(noticeMeta.from_user_id),
      notice_type: readString(noticeMeta.notice_type),
      to_user_id: readUserId(noticeMeta.to_user_id),
    },
    reply_id: readString(value.reply_id),
    timestamp: readString(value.timestamp),
    type: readString(value.type),
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
