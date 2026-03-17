function createDeliveryProgress() {
  return {
    hasReplied: false,
    hasDelivered: false
  };
}
function resolveReplyToForSend(params) {
  return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied) ? params.replyToId : void 0;
}
function markReplyApplied(progress, replyToId) {
  if (replyToId && !progress.hasReplied) {
    progress.hasReplied = true;
  }
}
function markDelivered(progress) {
  progress.hasDelivered = true;
}
async function sendChunkedTelegramReplyText(params) {
  const applyDelivered = params.markDelivered ?? markDelivered;
  for (let i = 0; i < params.chunks.length; i += 1) {
    const chunk = params.chunks[i];
    if (!chunk) {
      continue;
    }
    const isFirstChunk = i === 0;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress
    });
    const shouldAttachQuote = Boolean(replyToMessageId) && Boolean(params.replyQuoteText) && (params.quoteOnlyOnFirstChunk !== true || isFirstChunk);
    await params.sendChunk({
      chunk,
      isFirstChunk,
      replyToMessageId,
      replyMarkup: isFirstChunk ? params.replyMarkup : void 0,
      replyQuoteText: shouldAttachQuote ? params.replyQuoteText : void 0
    });
    markReplyApplied(params.progress, replyToMessageId);
    applyDelivered(params.progress);
  }
}
export {
  createDeliveryProgress,
  markDelivered,
  markReplyApplied,
  resolveReplyToForSend,
  sendChunkedTelegramReplyText
};
