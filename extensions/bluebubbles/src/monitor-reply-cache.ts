import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const REPLY_CACHE_MAX = 2000;
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type BlueBubblesReplyCacheEntry = {
  accountId: string;
  messageId: string;
  shortId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  senderLabel?: string;
  body?: string;
  timestamp: number;
};

// Best-effort cache for resolving reply context when BlueBubbles webhooks omit sender/body.
const blueBubblesReplyCacheByMessageId = new Map<string, BlueBubblesReplyCacheEntry>();

// Bidirectional maps for short ID ↔ message GUID resolution (token savings optimization)
const blueBubblesShortIdToUuid = new Map<string, string>();
const blueBubblesUuidToShortId = new Map<string, string>();
let blueBubblesShortIdCounter = 0;

function generateShortId(): string {
  blueBubblesShortIdCounter += 1;
  return String(blueBubblesShortIdCounter);
}

export function rememberBlueBubblesReplyCache(
  entry: Omit<BlueBubblesReplyCacheEntry, "shortId">,
): BlueBubblesReplyCacheEntry {
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  // Check if we already have a short ID for this GUID
  let shortId = blueBubblesUuidToShortId.get(messageId);
  if (!shortId) {
    shortId = generateShortId();
    blueBubblesShortIdToUuid.set(shortId, messageId);
    blueBubblesUuidToShortId.set(messageId, shortId);
  }

  const fullEntry: BlueBubblesReplyCacheEntry = { ...entry, messageId, shortId };

  // Refresh insertion order.
  blueBubblesReplyCacheByMessageId.delete(messageId);
  blueBubblesReplyCacheByMessageId.set(messageId, fullEntry);

  // Opportunistic prune.
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  for (const [key, value] of blueBubblesReplyCacheByMessageId) {
    if (value.timestamp < cutoff) {
      blueBubblesReplyCacheByMessageId.delete(key);
      // Clean up short ID mappings for expired entries
      if (value.shortId) {
        blueBubblesShortIdToUuid.delete(value.shortId);
        blueBubblesUuidToShortId.delete(key);
      }
      continue;
    }
    break;
  }
  while (blueBubblesReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
    const oldest = blueBubblesReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = blueBubblesReplyCacheByMessageId.get(oldest);
    blueBubblesReplyCacheByMessageId.delete(oldest);
    // Clean up short ID mappings for evicted entries
    if (oldEntry?.shortId) {
      blueBubblesShortIdToUuid.delete(oldEntry.shortId);
      blueBubblesUuidToShortId.delete(oldest);
    }
  }

  return fullEntry;
}

export type BlueBubblesChatContext = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
};

/**
 * Cross-chat guard: compare a cached entry's chat fields with a caller-provided
 * context. Returns true when the two clearly reference different chats.
 *
 * Comparison rules mirror resolveReplyContextFromCache so outbound short-ID
 * resolution and inbound reply-context lookup agree on scope:
 *
 *   - If both sides carry a chatGuid and they differ, that is the strongest
 *     signal of a cross-chat reuse.
 *   - Otherwise, if the caller has no chatGuid but both sides carry a
 *     chatIdentifier and they differ, that is also a mismatch. This covers
 *     handle-only callers (tapback into a DM where the caller only resolved
 *     a handle) against cached entries that still carry chatGuid from the
 *     inbound webhook.
 *   - Otherwise, if the caller has neither chatGuid nor chatIdentifier but
 *     both sides carry a chatId and they differ, that is also a mismatch.
 *
 * Absent identifiers on either side are treated as "no information" rather
 * than a mismatch, so ambiguous calls fall through as-is.
 */
function isCrossChatMismatch(
  cached: BlueBubblesReplyCacheEntry,
  ctx: BlueBubblesChatContext,
): boolean {
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
  if (cachedChatGuid && ctxChatGuid && cachedChatGuid !== ctxChatGuid) {
    return true;
  }
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
  if (
    !ctxChatGuid &&
    cachedChatIdentifier &&
    ctxChatIdentifier &&
    cachedChatIdentifier !== ctxChatIdentifier
  ) {
    return true;
  }
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;
  const ctxChatId = typeof ctx.chatId === "number" ? ctx.chatId : undefined;
  if (
    !ctxChatGuid &&
    !ctxChatIdentifier &&
    cachedChatId !== undefined &&
    ctxChatId !== undefined &&
    cachedChatId !== ctxChatId
  ) {
    return true;
  }
  return false;
}

function describeChatForError(values: {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
}): string {
  const parts: string[] = [];
  const guid = normalizeOptionalString(values.chatGuid);
  if (guid) {
    parts.push(`chatGuid=${guid}`);
  }
  const identifier = normalizeOptionalString(values.chatIdentifier);
  if (identifier) {
    parts.push(`chatIdentifier=${identifier}`);
  }
  if (typeof values.chatId === "number") {
    parts.push(`chatId=${values.chatId}`);
  }
  return parts.length === 0 ? "<unknown chat>" : parts.join(", ");
}

/**
 * Resolves a short message ID (e.g., "1", "2") to a full BlueBubbles GUID.
 * Returns the input unchanged if it's already a GUID or not found in the mapping.
 *
 * When `chatContext` is provided, the resolved UUID's cached chat must match
 * the caller's chat or the call throws. This prevents a short ID that points
 * at a message in chat A from being silently reused in chat B — the common
 * symptom being tapbacks and quoted replies landing in the wrong conversation
 * (e.g. a group reaction showing up in a DM) because short IDs are allocated
 * from a single global counter across every account and chat.
 */
export function resolveBlueBubblesMessageId(
  shortOrUuid: string,
  opts?: { requireKnownShortId?: boolean; chatContext?: BlueBubblesChatContext },
): string {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }

  // If it looks like a short ID (numeric), try to resolve it
  if (/^\d+$/.test(trimmed)) {
    const uuid = blueBubblesShortIdToUuid.get(trimmed);
    if (uuid) {
      if (opts?.chatContext) {
        const cached = blueBubblesReplyCacheByMessageId.get(uuid);
        if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
          throw new Error(
            `BlueBubbles short message id "${trimmed}" belongs to a different chat ` +
              `(${describeChatForError(cached)}) than the current call target ` +
              `(${describeChatForError(opts.chatContext)}). Retry with the full message GUID ` +
              `to avoid cross-chat reactions/replies landing in the wrong conversation.`,
          );
        }
      }
      return uuid;
    }
    if (opts?.requireKnownShortId) {
      throw new Error(
        `BlueBubbles short message id "${trimmed}" is no longer available. Use MessageSidFull.`,
      );
    }
  }

  // Return as-is (either already a UUID or not found)
  return trimmed;
}

/**
 * Resets the short ID state. Only use in tests.
 * @internal
 */
export function _resetBlueBubblesShortIdState(): void {
  blueBubblesShortIdToUuid.clear();
  blueBubblesUuidToShortId.clear();
  blueBubblesReplyCacheByMessageId.clear();
  blueBubblesShortIdCounter = 0;
}

/**
 * Gets the short ID for a message GUID, if one exists.
 */
export function getShortIdForUuid(uuid: string): string | undefined {
  return blueBubblesUuidToShortId.get(uuid.trim());
}

export function resolveReplyContextFromCache(params: {
  accountId: string;
  replyToId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
}): BlueBubblesReplyCacheEntry | null {
  const replyToId = params.replyToId.trim();
  if (!replyToId) {
    return null;
  }

  const cached = blueBubblesReplyCacheByMessageId.get(replyToId);
  if (!cached) {
    return null;
  }
  if (cached.accountId !== params.accountId) {
    return null;
  }

  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  if (cached.timestamp < cutoff) {
    blueBubblesReplyCacheByMessageId.delete(replyToId);
    return null;
  }

  const chatGuid = normalizeOptionalString(params.chatGuid);
  const chatIdentifier = normalizeOptionalString(params.chatIdentifier);
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const chatId = typeof params.chatId === "number" ? params.chatId : undefined;
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;

  // Avoid cross-chat collisions if we have identifiers.
  if (chatGuid && cachedChatGuid && chatGuid !== cachedChatGuid) {
    return null;
  }
  if (
    !chatGuid &&
    chatIdentifier &&
    cachedChatIdentifier &&
    chatIdentifier !== cachedChatIdentifier
  ) {
    return null;
  }
  if (!chatGuid && !chatIdentifier && chatId && cachedChatId && chatId !== cachedChatId) {
    return null;
  }

  return cached;
}
