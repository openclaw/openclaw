import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { encodeQuery, formatFeishuApiError } from "./comment-shared.js";
import { parseFeishuCommentTarget, type CommentFileType } from "./comment-target.js";

const COMMENT_TYPING_REACTION_TYPE = "Typing";
const COMMENT_REACTION_TIMEOUT_MS = 30_000;
const activeCommentTypingReactions = new Set<string>();

function buildCommentTypingReactionKey(params: {
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
}): string {
  return `${params.fileType}:${params.fileToken}:${params.replyId}`;
}

async function requestCommentTypingReactionWithClient(params: {
  client: ReturnType<typeof createFeishuClient>;
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
  action: "add" | "delete";
  runtime?: RuntimeEnv;
  logPrefix?: string;
}): Promise<boolean> {
  try {
    const response = await params.client.request<{
      code?: number;
      msg?: string;
      log_id?: string;
      error?: { log_id?: string };
    }>({
      method: "POST",
      url:
        `/open-apis/drive/v2/files/${encodeURIComponent(params.fileToken)}/comments/reaction` +
        encodeQuery({
          file_type: params.fileType,
        }),
      data: {
        action: params.action,
        reply_id: params.replyId,
        reaction_type: COMMENT_TYPING_REACTION_TYPE,
      },
      timeout: COMMENT_REACTION_TIMEOUT_MS,
    });
    if (response.code === 0) {
      return true;
    }
    params.runtime?.log?.(
      `${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} failed ` +
        `reply=${params.replyId} file=${params.fileType}:${params.fileToken} ` +
        `code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"} ` +
        `log_id=${response.log_id ?? response.error?.log_id ?? "unknown"}`,
    );
  } catch (error) {
    params.runtime?.log?.(
      `${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} threw ` +
        `reply=${params.replyId} file=${params.fileType}:${params.fileToken} ` +
        `error=${formatFeishuApiError(error, { includeNestedErrorLogId: true })}`,
    );
  }
  return false;
}

async function requestCommentTypingReaction(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
  action: "add" | "delete";
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<boolean> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured || !account.config.typingIndicator) {
    return false;
  }
  return requestCommentTypingReactionWithClient({
    client: createFeishuClient(account),
    fileToken: params.fileToken,
    fileType: params.fileType,
    replyId: params.replyId,
    action: params.action,
    runtime: params.runtime,
    logPrefix: `feishu[${account.accountId}]`,
  });
}

async function cleanupCommentTypingReactionByKey(params: {
  key: string;
  performDelete: () => Promise<boolean>;
}): Promise<boolean> {
  if (!activeCommentTypingReactions.delete(params.key)) {
    return false;
  }
  return await params.performDelete();
}

export async function cleanupAmbientCommentTypingReaction(params: {
  client: ReturnType<typeof createFeishuClient>;
  deliveryContext?: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<boolean> {
  const deliveryContext = params.deliveryContext;
  if (
    deliveryContext?.channel &&
    deliveryContext.channel !== "feishu" &&
    deliveryContext.channel !== "feishu-comment"
  ) {
    return false;
  }
  const target = parseFeishuCommentTarget(deliveryContext?.to);
  const replyId =
    typeof deliveryContext?.threadId === "string" || typeof deliveryContext?.threadId === "number"
      ? String(deliveryContext.threadId).trim()
      : "";
  if (!target || !replyId) {
    return false;
  }
  const key = buildCommentTypingReactionKey({
    ...target,
    replyId,
  });
  return cleanupCommentTypingReactionByKey({
    key,
    performDelete: () =>
      requestCommentTypingReactionWithClient({
        ...target,
        client: params.client,
        replyId,
        action: "delete",
        logPrefix: "[feishu]",
      }),
  });
}

export function createCommentTypingReactionLifecycle(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: CommentFileType;
  replyId?: string;
  accountId?: string;
  runtime?: RuntimeEnv;
}) {
  const replyId = params.replyId?.trim();
  const key = replyId
    ? buildCommentTypingReactionKey({
        ...params,
        replyId,
      })
    : undefined;

  return {
    start: async (): Promise<void> => {
      if (!key || !replyId || activeCommentTypingReactions.has(key)) {
        return;
      }
      const added = await requestCommentTypingReaction({
        ...params,
        replyId,
        action: "add",
      });
      if (added) {
        activeCommentTypingReactions.add(key);
      }
    },
    cleanup: async (): Promise<void> => {
      if (!key || !replyId) {
        return;
      }
      await cleanupCommentTypingReactionByKey({
        key,
        performDelete: () =>
          requestCommentTypingReaction({
            ...params,
            replyId,
            action: "delete",
          }),
      });
    },
  };
}
