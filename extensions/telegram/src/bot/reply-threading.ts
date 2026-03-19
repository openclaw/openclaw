import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";

export type DeliveryProgress = {
  hasReplied: boolean;
  hasDelivered: boolean;
};

export function createDeliveryProgress(): DeliveryProgress {
  return {
    hasReplied: false,
    hasDelivered: false,
  };
}

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

export function markDelivered(progress: DeliveryProgress): void {
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
  /** Optional predicate — return true to silently skip a chunk without marking delivered. */
  shouldSkipChunk?: (chunk: TChunk) => boolean;
  /**
   * Called for each non-skipped chunk. Return `false` to indicate the chunk
   * was silently skipped at the send layer (e.g. `sendTelegramText` returned
   * `undefined`) — in that case `markDelivered` is not called and the chunk
   * does not count toward `sentChunkCount`. Returning `void` or `true` (or
   * any other truthy value) marks the chunk as delivered.
   */
  sendChunk: (opts: {
    chunk: TChunk;
    /** True for the first chunk that is actually sent (skipped chunks are not counted). */
    isFirstChunk: boolean;
    replyToMessageId?: number;
    replyMarkup?: TReplyMarkup;
    replyQuoteText?: string;
  }) => Promise<boolean | void>;
}): Promise<void> {
  const applyDelivered = params.markDelivered ?? markDelivered;
  let sentChunkCount = 0;
  for (let i = 0; i < params.chunks.length; i += 1) {
    const chunk = params.chunks[i];
    if (!chunk) {
      continue;
    }
    if (params.shouldSkipChunk?.(chunk)) {
      continue;
    }
    const isFirstChunk = sentChunkCount === 0;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress,
    });
    const shouldAttachQuote =
      Boolean(replyToMessageId) &&
      Boolean(params.replyQuoteText) &&
      (params.quoteOnlyOnFirstChunk !== true || isFirstChunk);
    const sent = await params.sendChunk({
      chunk,
      isFirstChunk,
      replyToMessageId,
      replyMarkup: isFirstChunk ? params.replyMarkup : undefined,
      replyQuoteText: shouldAttachQuote ? params.replyQuoteText : undefined,
    });
    // Only mark delivered when sendChunk did not signal a silent skip (false).
    if (sent !== false) {
      markReplyApplied(params.progress, replyToMessageId);
      applyDelivered(params.progress);
      sentChunkCount += 1;
    }
  }
}
