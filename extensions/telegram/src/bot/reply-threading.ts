// Telegram plugin module implements reply threading behavior.
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";

export type DeliveryProgress = {
  hasReplied: boolean;
  hasDelivered: boolean;
};

export function resolveReplyToForSend(params: {
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): number | undefined {
  return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied)
    ? params.replyToId
    : undefined;
}

export function markReplyApplied(progress: DeliveryProgress, replyToId?: number): void {
  if (replyToId && !progress.hasReplied) {
    progress.hasReplied = true;
  }
}

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
}

export async function sendChunkedTelegramReplyText<
  TChunk,
  TReplyMarkup = unknown,
  TProgress extends DeliveryProgress = DeliveryProgress,
>(params: {
  chunks: readonly TChunk[];
  progress: TProgress;
  replyToId?: number;
  replyToMode: ReplyToMode;
  replyMarkup?: TReplyMarkup;
  replyQuoteText?: string;
  quoteOnlyOnFirstChunk?: boolean;
  markDelivered?: (progress: TProgress) => void;
  sendChunk: (opts: {
    chunk: TChunk;
    isFirstChunk: boolean;
    replyToMessageId?: number;
    replyMarkup?: TReplyMarkup;
    replyQuoteText?: string;
  }) => Promise<number | undefined>;
}): Promise<void> {
  const applyDelivered = params.markDelivered ?? markDelivered;
  const suppressSingleUseReply =
    params.chunks.length > 1 && isSingleUseReplyToMode(params.replyToMode);
  // One-time reply buttons and the first-only quote must land on the first
  // DELIVERED chunk, not chunk index 0. A chunk that renders to empty Telegram
  // content is skipped below; keying these on the index would consume them on
  // that skipped attempt and the actually-delivered chunk would lose them.
  let hasDeliveredChunk = false;
  for (const chunk of params.chunks) {
    if (!chunk) {
      continue;
    }
    const isFirstDeliveryAttempt = !hasDeliveredChunk;
    // Telegram Desktop can render long formatted native-reply chunks as
    // unsupported messages. Multi-part `first` replies consume the reply target
    // without adding native reply params, preserving visible text.
    const replyToMessageId = suppressSingleUseReply
      ? undefined
      : resolveReplyToForSend({
          replyToId: params.replyToId,
          replyToMode: params.replyToMode,
          progress: params.progress,
        });
    const shouldAttachQuote =
      Boolean(replyToMessageId) &&
      Boolean(params.replyQuoteText) &&
      (params.quoteOnlyOnFirstChunk !== true || isFirstDeliveryAttempt);
    const deliveredMessageId = await params.sendChunk({
      chunk,
      isFirstChunk: isFirstDeliveryAttempt,
      replyToMessageId,
      replyMarkup: isFirstDeliveryAttempt ? params.replyMarkup : undefined,
      replyQuoteText: shouldAttachQuote ? params.replyQuoteText : undefined,
    });
    // sendTelegramText resolves undefined for silently-skipped chunks (content
    // that renders to an empty Telegram payload). No real message id means no
    // reply/delivered accounting: otherwise deliveredCount, transcript mirror,
    // and message_sent would record a phantom send.
    if (deliveredMessageId == null) {
      continue;
    }
    // Suppressed single-use replies consume the reply target on the first
    // DELIVERED chunk (markReplyApplied is idempotent); keying on chunk index
    // would leak unconsumed state to later sends when chunk 0 silently skips.
    markReplyApplied(params.progress, suppressSingleUseReply ? params.replyToId : replyToMessageId);
    applyDelivered(params.progress);
    hasDeliveredChunk = true;
  }
}
