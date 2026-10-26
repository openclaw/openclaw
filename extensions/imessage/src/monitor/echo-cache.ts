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
  type ContentEntry = { timestamp: number; idTimestamp?: number };
  const textCache = new Map<string, ContentEntry>();
  const mediaCache = new Map<string, ContentEntry>();
  const messageIdCache = new Map<string, number>();

  function remember(scope: string, lookup: SentMessageLookup): void {
    const now = Date.now();
    const messageIdKey = normalizeIMessageMessageId(lookup.messageId);
    if (messageIdKey) {
      messageIdCache.set(`${scope}:${messageIdKey}`, now);
    }
    for (const [cache, value] of [
      [textCache, normalizeIMessageEchoText(lookup.text)],
      [mediaCache, resolveIMessageEchoMediaKey(lookup.media)],
    ] as const) {
      if (value) {
        const key = `${scope}:${value}`;
        cache.set(key, {
          timestamp: now,
          idTimestamp: messageIdKey ? now : cache.get(key)?.idTimestamp,
        });
      }
    }
    cleanup();
  }

  async function has(
    scope: string,
    lookup: SentMessageLookup,
    options: SentMessageLookupOptions = {},
  ): Promise<boolean> {
    if (
      await hasPersistedIMessageEcho({
        scope,
        text: lookup.text,
        media: lookup.media,
        messageId: lookup.messageId,
        skipIdShortCircuit: options.skipIdShortCircuit,
        includePendingText: options.includePendingText,
      })
    ) {
      return true;
    }
    cleanup();
    const textKey = normalizeIMessageEchoText(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const text = textKey ? textCache.get(`${scope}:${textKey}`) : undefined;
    const media = mediaKey ? mediaCache.get(`${scope}:${mediaKey}`) : undefined;
    const hasContentOnlyMatch = (entry: ContentEntry | undefined) =>
      Boolean(entry && (!entry.idTimestamp || entry.timestamp > entry.idTimestamp));
    const messageIdKey = normalizeIMessageMessageId(lookup.messageId);
    let canUseMediaFallback = !messageIdKey;
    if (messageIdKey) {
      if (messageIdCache.has(`${scope}:${messageIdKey}`)) {
        return true;
      }
      const hasTextOnlyMatch = hasContentOnlyMatch(text);
      const hasMediaOnlyMatch = hasContentOnlyMatch(media);
      canUseMediaFallback = hasMediaOnlyMatch;
      if (!options.skipIdShortCircuit && !hasTextOnlyMatch && !hasMediaOnlyMatch) {
        return false;
      }
    }
    return Boolean(text || (canUseMediaFallback && media));
  }

  function cleanup(): void {
    const now = Date.now();
    for (const cache of [textCache, mediaCache]) {
      for (const [key, entry] of cache) {
        if (now - entry.timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
          cache.delete(key);
        }
      }
    }
    for (const [key, timestamp] of messageIdCache) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        messageIdCache.delete(key);
      }
    }
  }
  return { remember, has };
}
