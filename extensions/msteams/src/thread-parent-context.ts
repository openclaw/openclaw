import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fetchChannelMessage, stripHtmlFromTeamsMessage } from "./graph-thread.js";
import type { GraphThreadMessage } from "./graph-thread.js";

const PARENT_CACHE_TTL_MS = 5 * 60 * 1000;
const PARENT_CACHE_MAX = 100;

type ParentCacheEntry = {
  message: GraphThreadMessage | undefined;
  expiresAt: number;
};

const parentCache = new Map<string, ParentCacheEntry>();

// Isolated thread sessions need their parent once, without repeating it on every reply.
const INJECTED_MAX = 200;
const injectedParents = new Map<string, string>();

type ThreadParentContextFetcher = (
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
) => Promise<GraphThreadMessage | undefined>;

function touchLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  pruneMapToMaxSize(map, max);
}

function buildParentCacheKey(groupId: string, channelId: string, parentId: string): string {
  return `${groupId}\u0000${channelId}\u0000${parentId}`;
}

function resolveParentCacheExpiresAt(nowRaw: number): number | undefined {
  const nowMs = asDateTimestampMs(nowRaw);
  return nowMs === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(PARENT_CACHE_TTL_MS, { nowMs });
}

export async function fetchParentMessageCached(
  token: string,
  groupId: string,
  channelId: string,
  parentId: string,
  fetchParent: ThreadParentContextFetcher = fetchChannelMessage,
): Promise<GraphThreadMessage | undefined> {
  const key = buildParentCacheKey(groupId, channelId, parentId);
  const now = asDateTimestampMs(Date.now());
  const cached = parentCache.get(key);
  const cachedExpiresAt = cached ? asDateTimestampMs(cached.expiresAt) : undefined;
  if (cached && now !== undefined && cachedExpiresAt !== undefined && cachedExpiresAt > now) {
    parentCache.delete(key);
    parentCache.set(key, cached);
    return cached.message;
  }
  if (cached) {
    parentCache.delete(key);
  }
  const message = await fetchParent(token, groupId, channelId, parentId);
  const expiresAt = resolveParentCacheExpiresAt(Date.now());
  if (expiresAt !== undefined) {
    touchLru(parentCache, key, { message, expiresAt }, PARENT_CACHE_MAX);
  }
  return message;
}

type ParentContextSummary = {
  /** Display name of the parent message author, or "unknown". */
  sender: string;
  /** Stripped, single-line parent body text (or empty if unresolved). */
  text: string;
};

const PARENT_TEXT_MAX_CHARS = 400;

export function summarizeParentMessage(
  message: GraphThreadMessage | undefined,
): ParentContextSummary | undefined {
  if (!message) {
    return undefined;
  }
  const sender =
    message.from?.user?.displayName ?? message.from?.application?.displayName ?? "unknown";
  const contentType = message.body?.contentType ?? "text";
  const raw = message.body?.content ?? "";
  const text =
    contentType === "html" ? stripHtmlFromTeamsMessage(raw) : raw.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return {
    sender,
    text:
      text.length > PARENT_TEXT_MAX_CHARS
        ? `${truncateUtf16Safe(text, PARENT_TEXT_MAX_CHARS - 1)}…`
        : text,
  };
}

export function formatParentContextEvent(summary: ParentContextSummary): string {
  return `Replying to @${summary.sender}: ${summary.text}`;
}

export function shouldInjectParentContext(sessionKey: string, parentId: string): boolean {
  return injectedParents.get(sessionKey) !== parentId;
}

export function markParentContextInjected(sessionKey: string, parentId: string): void {
  touchLru(injectedParents, sessionKey, parentId, INJECTED_MAX);
}
