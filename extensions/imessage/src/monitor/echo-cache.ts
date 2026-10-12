import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeIMessageMessageId } from "../message-guid.js";
import { resolveIMessageEchoMediaKey } from "../state-contract.js";
import { normalizeIMessageEchoText } from "./echo-text-corruption.js";
import { hasPersistedIMessageEcho } from "./persisted-echo-cache.js";

type SentMessageLookup = {
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
};

type SentMessageLookupOptions = {
  // Self-chat SQLite row IDs differ from outbound GUIDs; allow text matching after an ID miss.
  skipIdShortCircuit?: boolean;
  includePendingText?: boolean;
};

export type SentMessageCache = ReturnType<typeof createSentMessageCache>;

// Echo arrival observed at ~2.2s on M4 Mac Mini (SQLite poll interval is the bottleneck).
// 4s provides ~80% margin. If echoes arrive after TTL expiry, the system degrades to
// duplicate delivery (noisy but not lossy) — never message loss.
const SENT_MESSAGE_TEXT_TTL_MS = 4_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

export function createSentMessageCache() {
  const textCache = new Map<string, number>();
  const textBackedByIdCache = new Map<string, number>();
  const mediaCache = new Map<string, number>();
  const mediaBackedByIdCache = new Map<string, number>();
  const messageIdCache = new Map<string, number>();

  function remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeIMessageEchoText(lookup.text);
    if (textKey) {
      textCache.set(`${scope}:${textKey}`, Date.now());
    }
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    if (mediaKey) {
      mediaCache.set(`${scope}:${mediaKey}`, Date.now());
    }
    const messageIdKey = normalizeIMessageMessageId(lookup.messageId);
    if (messageIdKey) {
      messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
      if (textKey) {
        textBackedByIdCache.set(`${scope}:${textKey}`, Date.now());
      }
      if (mediaKey) {
        mediaBackedByIdCache.set(`${scope}:${mediaKey}`, Date.now());
      }
    }
    cleanup();
  }

  async function has(
    scope: string,
    lookup: SentMessageLookup,
    options: boolean | SentMessageLookupOptions = false,
  ): Promise<boolean> {
    cleanup();
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
    const matchesWithin = (cache: Map<string, number>, key: string | undefined, ttlMs: number) => {
      const timestamp = key ? cache.get(`${scope}:${key}`) : undefined;
      return Boolean(timestamp && Date.now() - timestamp <= ttlMs);
    };
    const hasContentOnlyMatch = (
      cache: Map<string, number>,
      backedById: Map<string, number>,
      key: string | undefined,
    ) => {
      const timestamp = key ? cache.get(`${scope}:${key}`) : undefined;
      const idTimestamp = key ? backedById.get(`${scope}:${key}`) : undefined;
      return typeof timestamp === "number" && (!idTimestamp || timestamp > idTimestamp);
    };
    const textKey = normalizeIMessageEchoText(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const messageIdKey = normalizeIMessageMessageId(lookup.messageId);
    let canUseMediaFallback = !messageIdKey;
    if (messageIdKey) {
      if (matchesWithin(messageIdCache, messageIdKey, SENT_MESSAGE_ID_TTL_MS)) {
        return true;
      }
      const hasTextOnlyMatch = hasContentOnlyMatch(textCache, textBackedByIdCache, textKey);
      const hasMediaOnlyMatch = hasContentOnlyMatch(mediaCache, mediaBackedByIdCache, mediaKey);
      canUseMediaFallback = hasMediaOnlyMatch;
      if (!resolvedOptions.skipIdShortCircuit && !hasTextOnlyMatch && !hasMediaOnlyMatch) {
        return false;
      }
    }
    return (
      matchesWithin(textCache, textKey, SENT_MESSAGE_TEXT_TTL_MS) ||
      (canUseMediaFallback && matchesWithin(mediaCache, mediaKey, SENT_MESSAGE_TEXT_TTL_MS))
    );
  }

  function cleanup(): void {
    const now = Date.now();
    for (const cache of [
      textCache,
      textBackedByIdCache,
      mediaCache,
      mediaBackedByIdCache,
      messageIdCache,
    ]) {
      const ttlMs = cache === messageIdCache ? SENT_MESSAGE_ID_TTL_MS : SENT_MESSAGE_TEXT_TTL_MS;
      for (const [key, timestamp] of cache) {
        if (now - timestamp > ttlMs) {
          cache.delete(key);
        }
      }
    }
  }
  return { remember, has };
}
