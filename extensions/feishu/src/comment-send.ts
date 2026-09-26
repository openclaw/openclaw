import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
// Feishu plugin module delivers reply text into a document comment thread.
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { chunkedFencesBalance } from "./markdown.js";
import type { FeishuOutboundDeliveryOptions } from "./outbound-delivery-options.js";
import {
  FEISHU_TEXT_CHUNK_LIMIT,
  aggregateFeishuSendResult,
  partialFeishuSendError,
  reportFeishuOutboundDelivery,
} from "./outbound-send-result.js";
import type { FeishuReplyDeliverySource } from "./reply-delivery-result.js";
import { sendMessageFeishu } from "./send.js";

export async function sendCommentThreadReply(
  params: FeishuOutboundDeliveryOptions & {
    cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
    to: string;
    text: string;
    replyId?: string;
    accountId?: string;
  },
) {
  const target = parseFeishuCommentTarget(params.to);
  if (!target) {
    return null;
  }
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  // Comments have no native table renderer, so block falls back to code here.
  const requestedTableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: false,
  });
  // A per-delivery cut takes precedence over the resolved account here too, the way core's
  // planner reads the pair, because the replies this loop posts are the ones the delivery
  // asked to be sized.
  const commentLimit =
    params.formatting?.textLimit ??
    resolveTextChunkLimit(params.cfg, "feishu", account.accountId, {
      fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
    });
  const commentChunkMode =
    params.formatting?.chunkMode ?? resolveChunkMode(params.cfg, "feishu", account.accountId);
  const requestedContent = convertMarkdownTables(params.text, requestedTableMode);
  // Comments this text cannot be cut into without stranding a fence would arrive as an
  // unterminated code block, so the table is left as it arrived instead.
  const tableMode =
    requestedTableMode === "code" &&
    !chunkedFencesBalance(requestedContent, commentLimit, commentChunkMode)
      ? "off"
      : requestedTableMode;
  const content =
    tableMode === requestedTableMode
      ? requestedContent
      : convertMarkdownTables(params.text, tableMode);
  // Core chunks raw text before channel rendering, so the conversion above can push
  // a unit past the limit it was cut to. Re-chunk after the expansion, the way the
  // post path below and the inbound comment dispatcher already do, so a fence is
  // closed and reopened rather than cut in half.
  const chunks = chunkMarkdownTextWithMode(content, commentLimit, commentChunkMode);
  const replyId = params.replyId?.trim();
  try {
    const results: Awaited<ReturnType<typeof deliverCommentThreadText>>[] = [];
    const sources: FeishuReplyDeliverySource[] = [];
    const acceptedChunks: string[] = [];
    for (const chunk of chunks.length ? chunks : [content]) {
      // Every reply here is its own physical send, so the cancellation question is asked
      // once per reply, the way the post path asks it. Ahead of the catch below, so an
      // abort stays an abort instead of arriving as a delivery failure.
      params.signal?.throwIfAborted();
      try {
        const result = await deliverCommentThreadText(client, {
          file_token: target.fileToken,
          file_type: target.fileType,
          comment_id: target.commentId,
          content: chunk,
        });
        // Record acceptance before a callback or later chunk can fail.
        results.push(result);
        acceptedChunks.push(chunk);
        const messageId =
          (result.delivery_mode === "reply_comment" ? result.reply_id : result.comment_id) ?? "";
        sources.push({ messageId });
        // Every physical reply is reported, the way the post path reports each of
        // its chunks, so a later one is not missing from delivery tracking.
        await reportFeishuOutboundDelivery(
          { messageId, chatId: target.commentId },
          params.onDeliveryResult,
        );
      } catch (error) {
        // The accepted comments carry the only text that reached the thread. Without it
        // the turn records the whole answer as delivered, because the shared lifecycle
        // falls back to the authored payload when a partial result has no content.
        throw partialFeishuSendError(error, sources, acceptedChunks.join(""));
      }
    }
    return aggregateFeishuSendResult(
      {
        // The first reply anchors the thread, which is the identity the shared merge
        // helper keeps when several sends carry one answer. The receipt below still
        // holds every one of them.
        messageId: sources[0]?.messageId ?? "",
        chatId: target.commentId,
        result: results[0]!,
      },
      sources,
    );
  } finally {
    if (replyId) {
      void cleanupAmbientCommentTypingReaction({
        client,
        deliveryContext: {
          channel: "feishu",
          to: params.to,
          threadId: replyId,
        },
      });
    }
  }
}
