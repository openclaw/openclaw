function parseTelegramReplyToMessageId(replyToId) {
  if (!replyToId) {
    return void 0;
  }
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function parseIntegerId(value) {
  if (!/^-?\d+$/.test(value)) {
    return void 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function parseTelegramThreadId(threadId) {
  if (threadId == null) {
    return void 0;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : void 0;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return void 0;
  }
  const scopedMatch = /^-?\d+:(-?\d+)$/.exec(trimmed);
  const rawThreadId = scopedMatch ? scopedMatch[1] : trimmed;
  return parseIntegerId(rawThreadId);
}
export {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId
};
