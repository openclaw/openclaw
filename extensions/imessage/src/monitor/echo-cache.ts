export type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

export type SentMessageCache = {
  remember: (scope: string, lookup: SentMessageLookup) => void;
  /**
   * Check whether an inbound message matches a recently-sent outbound message.
   *
   * @param skipIdShortCircuit - When true, skip the early return on message-ID
   *   mismatch and fall through to text-based matching. Use this for self-chat
   *   `is_from_me=true` messages where the inbound ID is a numeric SQLite row ID
   *   that will never match the GUID outbound IDs, but text matching is still
   *   the right way to identify agent reply echoes.
   */
  has: (scope: string, lookup: SentMessageLookup, skipIdShortCircuit?: boolean) => boolean;
};

// Keep the text fallback short so repeated user replies like "ok" are not
// suppressed for long; delayed reflections should match the stronger message-id key.
const SENT_MESSAGE_TEXT_TTL_MS = 3_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function normalizeEchoMessageIdKey(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

class DefaultSentMessageCache implements SentMessageCache {
  private textCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      this.textCache.set(`${scope}:${textKey}`, Date.now());
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
    }
    this.cleanup();
  }

  has(scope: string, lookup: SentMessageLookup, skipIdShortCircuit = false): boolean {
    this.cleanup();
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
      // If the inbound message has a valid message id that doesn't match any
      // cached id, skip the text fallback — the message is not an echo.
      //
      // In practice, inbound message.id is a numeric SQLite row ID (e.g. "200")
      // while outbound sent.messageId is a GUID string (e.g. "p:0/abc-def-...").
      // These formats never collide, so this early return effectively disables
      // text-based echo matching for all messages that arrive with a DB row ID.
      //
      // Exception: when skipIdShortCircuit=true (self-chat is_from_me=true
      // messages), we skip this early return so text matching can still identify
      // agent reply echoes even though IDs never match in this scenario.
      if (!skipIdShortCircuit) {
        return false;
      }
    }
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.textCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, timestamp] of this.messageIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
