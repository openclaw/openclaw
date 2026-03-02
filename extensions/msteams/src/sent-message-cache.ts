const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  timestamps: Map<string, number>;
};

const sentMessages = new Map<string, CacheEntry>();

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.timestamps.delete(msgId);
    }
  }
}

export function recordMSTeamsSentMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) {
    return;
  }
  let entry = sentMessages.get(conversationId);
  if (!entry) {
    entry = { timestamps: new Map() };
    sentMessages.set(conversationId, entry);
  }
  entry.timestamps.set(messageId, Date.now());
  if (entry.timestamps.size > 200) {
    cleanupExpired(entry);
  }
}

export function wasMSTeamsMessageSent(conversationId: string, messageId: string): boolean {
  const entry = sentMessages.get(conversationId);
  if (!entry) {
    return false;
  }
  cleanupExpired(entry);
  return entry.timestamps.has(messageId);
}

export function clearMSTeamsSentMessageCache(): void {
  sentMessages.clear();
}
