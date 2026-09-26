import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import { resolveIMessageEchoMediaKey } from "../state-contract.js";
import { normalizeIMessageEchoText } from "./echo-text-corruption.js";
import { hasPersistedIMessageEcho } from "./persisted-echo-cache.js";

type SentMessageLookup = {
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
};

type SentMessageLookupOptions = {
  skipIdShortCircuit?: boolean;
  includePendingText?: boolean;
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
  has: (
    scope: string,
    lookup: SentMessageLookup,
    options?: boolean | SentMessageLookupOptions,
  ) => Promise<boolean>;
};

// Echo arrival observed at ~2.2s on M4 Mac Mini (SQLite poll interval is the bottleneck).
// 4s provides ~80% margin. If echoes arrive after TTL expiry, the system degrades to
// duplicate delivery (noisy but not lossy) — never message loss.
const SENT_MESSAGE_TEXT_TTL_MS = 4_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

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
  private textBackedByIdCache = new Map<string, number>();
  private mediaCache = new Map<string, number>();
  private mediaBackedByIdCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeIMessageEchoText(lookup.text);
    if (textKey) {
      this.textCache.set(`${scope}:${textKey}`, Date.now());
    }
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    if (mediaKey) {
      this.mediaCache.set(`${scope}:${mediaKey}`, Date.now());
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
      if (textKey) {
        this.textBackedByIdCache.set(`${scope}:${textKey}`, Date.now());
      }
      if (mediaKey) {
        this.mediaBackedByIdCache.set(`${scope}:${mediaKey}`, Date.now());
      }
    }
    this.cleanup();
  }

  async has(
    scope: string,
    lookup: SentMessageLookup,
    options: boolean | SentMessageLookupOptions = false,
  ): Promise<boolean> {
    this.cleanup();
    const resolvedOptions =
      typeof options === "boolean" ? { skipIdShortCircuit: options } : options;
    if (
      await hasPersistedIMessageEcho({
        scope,
        text: lookup.text,
        media: lookup.media,
        messageId: lookup.messageId,
        skipIdShortCircuit: resolvedOptions.skipIdShortCircuit,
        includePendingText: resolvedOptions.includePendingText,
      })
    ) {
      return true;
    }
    const textKey = normalizeIMessageEchoText(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    let canUseMediaFallback = !messageIdKey;
    if (messageIdKey) {
      const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
      const textTimestamp = textKey ? this.textCache.get(`${scope}:${textKey}`) : undefined;
      const textBackedByIdTimestamp = textKey
        ? this.textBackedByIdCache.get(`${scope}:${textKey}`)
        : undefined;
      const hasTextOnlyMatch =
        typeof textTimestamp === "number" &&
        (!textBackedByIdTimestamp || textTimestamp > textBackedByIdTimestamp);
      const mediaTimestamp = mediaKey ? this.mediaCache.get(`${scope}:${mediaKey}`) : undefined;
      const mediaBackedByIdTimestamp = mediaKey
        ? this.mediaBackedByIdCache.get(`${scope}:${mediaKey}`)
        : undefined;
      const hasMediaOnlyMatch =
        typeof mediaTimestamp === "number" &&
        (!mediaBackedByIdTimestamp || mediaTimestamp > mediaBackedByIdTimestamp);
      canUseMediaFallback = hasMediaOnlyMatch;
      if (!resolvedOptions.skipIdShortCircuit && !hasTextOnlyMatch && !hasMediaOnlyMatch) {
        return false;
      }
    }
    if (textKey) {
      const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    if (mediaKey && canUseMediaFallback) {
      const mediaTimestamp = this.mediaCache.get(`${scope}:${mediaKey}`);
      if (mediaTimestamp && Date.now() - mediaTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const cache of [
      this.textCache,
      this.textBackedByIdCache,
      this.mediaCache,
      this.mediaBackedByIdCache,
      this.messageIdCache,
    ]) {
      const ttlMs =
        cache === this.messageIdCache ? SENT_MESSAGE_ID_TTL_MS : SENT_MESSAGE_TEXT_TTL_MS;
      for (const [key, timestamp] of cache) {
        if (now - timestamp > ttlMs) {
          cache.delete(key);
        }
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
