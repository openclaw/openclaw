import { normalizeTelegramLookupTarget, parseTelegramTarget } from "./targets.js";
const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;
function normalizeTelegramTargetBody(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, "").trim();
  if (!prefixStripped) {
    return void 0;
  }
  const parsed = parseTelegramTarget(trimmed);
  const normalizedChatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!normalizedChatId) {
    return void 0;
  }
  const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
  const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
  const chatSegment = keepLegacyGroupPrefix ? `group:${normalizedChatId}` : normalizedChatId;
  if (parsed.messageThreadId == null) {
    return chatSegment;
  }
  const threadSuffix = hasTopicSuffix ? `:topic:${parsed.messageThreadId}` : `:${parsed.messageThreadId}`;
  return `${chatSegment}${threadSuffix}`;
}
function normalizeTelegramMessagingTarget(raw) {
  const normalizedBody = normalizeTelegramTargetBody(raw);
  if (!normalizedBody) {
    return void 0;
  }
  return `telegram:${normalizedBody}`.toLowerCase();
}
function looksLikeTelegramTargetId(raw) {
  return normalizeTelegramTargetBody(raw) !== void 0;
}
export {
  looksLikeTelegramTargetId,
  normalizeTelegramMessagingTarget
};
