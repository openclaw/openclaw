import { createScopedExpiringIdCache } from "openclaw/plugin-sdk/text-runtime";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sentMessageCache = createScopedExpiringIdCache<string, string>({
  store: new Map<string, Map<string, number>>(),
  ttlMs: TTL_MS,
  cleanupThreshold: 200,
});

export function recordMSTeamsSentMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) {
    return;
  }
  sentMessageCache.record(conversationId, messageId);
}

export function wasMSTeamsMessageSent(conversationId: string, messageId: string): boolean {
  return sentMessageCache.has(conversationId, messageId);
}

export function clearMSTeamsSentMessageCache(): void {
  sentMessageCache.clear();
}
