// Feishu plugin module implements comment dispatcher behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "./comment-dispatcher-runtime-api.js";
import { createCommentTypingReactionLifecycle } from "./comment-reaction.js";
import type { CommentFileType } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import { getFeishuRuntime } from "./runtime.js";

type CreateFeishuCommentReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  accountId?: string;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  replyId?: string;
  isWholeComment?: boolean;
};

export function createFeishuCommentReplyDispatcher(
  params: CreateFeishuCommentReplyDispatcherParams,
) {
  const core = getFeishuRuntime();
  const prefixContext = createReplyPrefixContext({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
  });
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    "feishu",
    params.accountId,
    {
      fallbackLimit: 4000,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "feishu", params.accountId);
  const typingReaction = createCommentTypingReactionLifecycle({
    cfg: params.cfg,
    fileToken: params.fileToken,
    fileType: params.fileType,
    replyId: params.replyId,
    accountId: params.accountId,
    runtime: params.runtime,
  });
  const deliveryProgressByKey = new Map<
    string,
    {
      chunks: string[];
      results: Map<number, FeishuReplyDeliverySource | undefined>;
    }
  >();

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(params.cfg, params.agentId),
    onReplyStart: async () => {
      await typingReaction.start();
    },
    onCleanup: () => {
      deliveryProgressByKey.clear();
      void typingReaction.cleanup();
    },
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    deliver: async (payload: ReplyPayload, info) => {
      if (info.kind !== "final") {
        return noVisibleFeishuReplyDelivery;
      }
      const deliveryId = info.deliveryId;
      if (deliveryId === undefined) {
        throw new Error("Feishu comment delivery requires dispatcher delivery identity");
      }
      const reply = resolveSendableOutboundReplyParts(payload);
      if (!reply.hasText) {
        if (reply.hasMedia) {
          params.runtime.log?.(
            `feishu[${params.accountId ?? "default"}]: comment reply ignored media-only payload for comment=${params.commentId}`,
          );
        }
        return noVisibleFeishuReplyDelivery;
      }
      // Delivery identity stays stable for retries but differs for separate identical replies.
      // Content or optional assistant metadata cannot safely provide that distinction.
      const progressKey = String(deliveryId);
      const progress = deliveryProgressByKey.get(progressKey) ?? {
        chunks: core.channel.text.chunkTextWithMode(reply.text, textChunkLimit, chunkMode),
        results: new Map<number, FeishuReplyDeliverySource | undefined>(),
      };
      deliveryProgressByKey.set(progressKey, progress);
      const { chunks, results: resultsByIndex } = progress;
      const listResults = () =>
        chunks.flatMap((_chunk, index) => {
          const result = resultsByIndex.get(index);
          return result ? [result] : [];
        });
      for (const [index, chunk] of chunks.entries()) {
        if (resultsByIndex.has(index)) {
          continue;
        }
        try {
          const result = await deliverCommentThreadText(client, {
            file_token: params.fileToken,
            file_type: params.fileType,
            comment_id: params.commentId,
            content: chunk,
            is_whole_comment: params.isWholeComment,
          });
          const messageId =
            result.delivery_mode === "reply_comment" ? result.reply_id : result.comment_id;
          resultsByIndex.set(
            index,
            typeof messageId === "string" && messageId ? { messageId } : undefined,
          );
        } catch (error: unknown) {
          throw createFeishuPartialReplyDeliveryError(
            error,
            createFeishuReplyDeliveryResult({
              results: listResults(),
              visibleReplySent: resultsByIndex.size > 0,
              content: chunks
                .filter((_deliveredChunk, chunkIndex) => resultsByIndex.has(chunkIndex))
                .join("\n"),
              kind: "text",
            }),
            chunks.flatMap((_pendingChunk, pendingIndex) =>
              resultsByIndex.has(pendingIndex)
                ? []
                : [{ kind: "text" as const, index: pendingIndex }],
            ),
          );
        }
      }
      const results = listResults();
      deliveryProgressByKey.delete(progressKey);
      return createFeishuReplyDeliveryResult({
        results,
        visibleReplySent: chunks.length > 0,
        content: reply.text,
        kind: "text",
      });
    },
    onError: (err, info) => {
      params.runtime.error?.(
        `feishu[${params.accountId ?? "default"}]: comment dispatcher failed kind=${info.kind} comment=${params.commentId}: ${String(err)}`,
      );
    },
  };

  return {
    dispatcherOptions,
    delivery,
    startTypingReaction: typingReaction.start,
    cleanupTypingReaction: typingReaction.cleanup,
  };
}
