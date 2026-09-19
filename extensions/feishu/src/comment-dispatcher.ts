import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyPrefixContext } from "openclaw/plugin-sdk/channel-outbound";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ClawdbotConfig, ReplyPayload, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createCommentTypingReactionLifecycle } from "./comment-reaction.js";
import type { CommentFileType } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { chunkedFencesBalance } from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { buildFeishuPresentationFallback, resolveFeishuRichReply } from "./presentation-card.js";
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
    account.accountId,
    {
      fallbackLimit: 4000,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "feishu", account.accountId);
  // Comments have no native table renderer, so block falls back to code here.
  const requestedTableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: false,
  });
  const typingReaction = createCommentTypingReactionLifecycle({
    cfg: params.cfg,
    fileToken: params.fileToken,
    fileType: params.fileType,
    replyId: params.replyId,
    accountId: params.accountId,
    runtime: params.runtime,
  });

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(params.cfg, params.agentId),
    onReplyStart: async () => {
      await typingReaction.start();
    },
    onCleanup: () => {
      void typingReaction.cleanup();
    },
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    deliver: async (payload: ReplyPayload, info) => {
      if (info.kind !== "final") {
        return noVisibleFeishuReplyDelivery;
      }
      const reply = resolveSendableOutboundReplyParts(payload);
      const { presentation } = resolveFeishuRichReply(payload);
      let { commentText: text } = buildFeishuPresentationFallback({
        text: reply.text,
        presentation,
      });
      for (const mediaUrl of reply.mediaUrls) {
        text = await buildFeishuMediaFallbackText({ text, mediaUrl, mediaLinkStyle: "plain" });
      }
      if (!text.trim()) {
        return noVisibleFeishuReplyDelivery;
      }
      const requestedTableText = core.channel.text.convertMarkdownTables(text, requestedTableMode);
      // Comments this reply cannot be cut into without stranding a fence would arrive
      // as an unterminated code block, so the table is left as it arrived instead.
      const tableText =
        requestedTableMode === "code" &&
        !chunkedFencesBalance(requestedTableText, textChunkLimit, chunkMode)
          ? core.channel.text.convertMarkdownTables(text, "off")
          : requestedTableText;
      // A converted table is a fenced block, so the chunker has to close and reopen the
      // fence rather than cut it in half.
      const chunks = core.channel.text.chunkMarkdownTextWithMode(
        tableText,
        textChunkLimit,
        chunkMode,
      );
      const results: FeishuReplyDeliverySource[] = [];
      const acceptedChunks: string[] = [];
      for (const chunk of chunks) {
        try {
          const result = await deliverCommentThreadText(client, {
            file_token: params.fileToken,
            file_type: params.fileType,
            comment_id: params.commentId,
            content: chunk,
            is_whole_comment: params.isWholeComment,
          });
          results.push({
            messageId:
              result.delivery_mode === "reply_comment" ? result.reply_id : result.comment_id,
          });
          acceptedChunks.push(chunk);
        } catch (error: unknown) {
          throw createFeishuPartialReplyDeliveryError(
            error,
            createFeishuReplyDeliveryResult({
              results,
              visibleReplySent: results.length > 0,
              content: acceptedChunks.join(""),
              kind: "text",
            }),
          );
        }
      }
      return createFeishuReplyDeliveryResult({
        results,
        visibleReplySent: results.length > 0,
        content: tableText,
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
