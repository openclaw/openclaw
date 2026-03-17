import { resolveGlobalMap } from "../../../src/shared/global-singleton.js";
const TTL_MS = 24 * 60 * 60 * 1e3;
const TELEGRAM_SENT_MESSAGES_KEY = /* @__PURE__ */ Symbol.for("openclaw.telegramSentMessages");
const sentMessages = resolveGlobalMap(TELEGRAM_SENT_MESSAGES_KEY);
function getChatKey(chatId) {
  return String(chatId);
}
function cleanupExpired(entry) {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.timestamps.delete(msgId);
    }
  }
}
function recordSentMessage(chatId, messageId) {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { timestamps: /* @__PURE__ */ new Map() };
    sentMessages.set(key, entry);
  }
  entry.timestamps.set(messageId, Date.now());
  if (entry.timestamps.size > 100) {
    cleanupExpired(entry);
  }
}
function wasSentByBot(chatId, messageId) {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  cleanupExpired(entry);
  return entry.timestamps.has(messageId);
}
function clearSentMessageCache() {
  sentMessages.clear();
}
export {
  clearSentMessageCache,
  recordSentMessage,
  wasSentByBot
};
