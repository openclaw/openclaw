const TTL_MS = 24 * 60 * 60 * 1e3;
const sentMessages = /* @__PURE__ */ new Map();
function cleanupExpired(entry) {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.timestamps.delete(msgId);
    }
  }
}
function recordMSTeamsSentMessage(conversationId, messageId) {
  if (!conversationId || !messageId) {
    return;
  }
  let entry = sentMessages.get(conversationId);
  if (!entry) {
    entry = { timestamps: /* @__PURE__ */ new Map() };
    sentMessages.set(conversationId, entry);
  }
  entry.timestamps.set(messageId, Date.now());
  if (entry.timestamps.size > 200) {
    cleanupExpired(entry);
  }
}
function wasMSTeamsMessageSent(conversationId, messageId) {
  const entry = sentMessages.get(conversationId);
  if (!entry) {
    return false;
  }
  cleanupExpired(entry);
  return entry.timestamps.has(messageId);
}
function clearMSTeamsSentMessageCache() {
  sentMessages.clear();
}
export {
  clearMSTeamsSentMessageCache,
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSent
};
