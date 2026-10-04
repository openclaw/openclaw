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
    const textKey = normalizeIMessageEchoText(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const messageIdKey = normalizeIMessageMessageId(lookup.messageId);
    let canUseMediaFallback = !messageIdKey;
    if (messageIdKey) {
      const idTimestamp = messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
      const textTimestamp = textKey ? textCache.get(`${scope}:${textKey}`) : undefined;
      const textBackedByIdTimestamp = textKey
        ? textBackedByIdCache.get(`${scope}:${textKey}`)
        : undefined;
      const hasTextOnlyMatch =
        typeof textTimestamp === "number" &&
        (!textBackedByIdTimestamp || textTimestamp > textBackedByIdTimestamp);
      const mediaTimestamp = mediaKey ? mediaCache.get(`${scope}:${mediaKey}`) : undefined;
      const mediaBackedByIdTimestamp = mediaKey
        ? mediaBackedByIdCache.get(`${scope}:${mediaKey}`)
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
      const textTimestamp = textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    if (mediaKey && canUseMediaFallback) {
      const mediaTimestamp = mediaCache.get(`${scope}:${mediaKey}`);
      if (mediaTimestamp && Date.now() - mediaTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
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
