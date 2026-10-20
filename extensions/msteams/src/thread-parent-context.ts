import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fetchChannelMessage, stripHtmlFromTeamsMessage } from "./graph-thread.js";
import type { GraphThreadMessage } from "./graph-thread.js";
import type { MSTeamsRequestDeadline } from "./request-timeout.js";

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

function touchLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  pruneMapToMaxSize(map, max);
}

export async function fetchParentMessageCached(
  token: string,
  groupId: string,
  channelId: string,
  parentId: string,
  deadline?: MSTeamsRequestDeadline,
): Promise<GraphThreadMessage | undefined> {
  const key = JSON.stringify([sha256Hex(token), groupId, channelId, parentId]);
  const cached = parentCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    parentCache.delete(key);
    parentCache.set(key, cached);
    return cached.message;
  }
  if (cached) {
    parentCache.delete(key);
  }
  const message = await fetchChannelMessage(token, groupId, channelId, parentId, deadline);
  touchLru(
    parentCache,
    key,
    { message, expiresAt: Date.now() + PARENT_CACHE_TTL_MS },
    PARENT_CACHE_MAX,
  );
  return message;
}

const PARENT_TEXT_MAX_CHARS = 400;

export function formatParentContextEvent(
  message: GraphThreadMessage | undefined,
): string | undefined {
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
  const summaryText =
    text.length > PARENT_TEXT_MAX_CHARS
      ? `${truncateUtf16Safe(text, PARENT_TEXT_MAX_CHARS - 1)}…`
      : text;
  return `Replying to @${sender}: ${summaryText}`;
}

export function shouldInjectParentContext(sessionKey: string, parentId: string): boolean {
  return injectedParents.get(sessionKey) !== parentId;
}

export function markParentContextInjected(sessionKey: string, parentId: string): void {
  touchLru(injectedParents, sessionKey, parentId, INJECTED_MAX);
}
