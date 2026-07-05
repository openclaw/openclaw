// Msteams plugin module implements graph thread behavior.
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { fetchAllGraphPages, fetchGraphJson } from "./graph.js";

export type GraphThreadMessage = {
  id?: string;
  from?: {
    user?: { displayName?: string; id?: string };
    application?: { displayName?: string; id?: string };
  };
  body?: { content?: string; contentType?: string };
  createdDateTime?: string;
};

// TTL cache for team ID -> group GUID mapping.
const teamGroupIdCache = new Map<string, { groupId: string; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Max pages to walk when paginating thread replies (50 pages × up to 50 per page = 2500 replies). */
const MAX_REPLY_PAGES = 50;

function resolveTeamGroupIdCacheExpiresAt(nowRaw = Date.now()): number | undefined {
  const now = asDateTimestampMs(nowRaw);
  return now === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(CACHE_TTL_MS, { nowMs: now });
}

/**
 * Strip HTML tags from Teams message content, preserving @mention display names.
 * Teams wraps mentions in <at>Name</at> tags.
 */
export function stripHtmlFromTeamsMessage(html: string): string {
  // Preserve mention display names by replacing <at>Name</at> with @Name.
  let text = html.replace(/<at[^>]*>(.*?)<\/at>/gi, "@$1");
  // Strip remaining HTML tags.
  text = text.replace(/<[^>]*>/g, " ");
  // Decode common HTML entities. &amp; must be decoded LAST to prevent
  // double-decoding (e.g. &amp;lt; → &lt; not <), matching decodeHtmlEntities
  // in inbound.ts.
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  // Normalize whitespace.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Resolve the Azure AD group GUID for a Teams conversation team ID.
 * Results are cached with a TTL to avoid repeated Graph API calls.
 */
export async function resolveTeamGroupId(
  token: string,
  conversationTeamId: string,
): Promise<string> {
  const cached = teamGroupIdCache.get(conversationTeamId);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    const expiresAt = asDateTimestampMs(cached.expiresAt);
    if (now !== undefined && expiresAt !== undefined && expiresAt > now) {
      return cached.groupId;
    }
    teamGroupIdCache.delete(conversationTeamId);
  }

  // The team ID in channelData is typically the group ID itself for standard teams.
  // Validate by fetching /teams/{id} and returning the confirmed id.
  // Requires Team.ReadBasic.All permission; fall back to raw ID if missing.
  try {
    const path = `/teams/${encodeURIComponent(conversationTeamId)}?$select=id`;
    const team = await fetchGraphJson<{ id?: string }>({ token, path });
    const groupId = team.id ?? conversationTeamId;

    // Only cache when the Graph lookup succeeds — caching a fallback raw ID
    // can cause silent failures for the entire TTL if the ID is not a valid
    // Graph team GUID (e.g. Bot Framework conversation key).
    const expiresAt = resolveTeamGroupIdCacheExpiresAt();
    if (expiresAt !== undefined) {
      teamGroupIdCache.set(conversationTeamId, {
        groupId,
        expiresAt,
      });
    }

    return groupId;
  } catch {
    // Fallback to raw team ID without caching so subsequent calls retry the
    // Graph lookup instead of using a potentially invalid cached value.
    return conversationTeamId;
  }
}

/**
 * Fetch a single channel message (the parent/root of a thread).
 * Returns undefined on error so callers can degrade gracefully.
 */
export async function fetchChannelMessage(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
): Promise<GraphThreadMessage | undefined> {
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}?$select=id,from,body,createdDateTime`;
  try {
    return await fetchGraphJson<GraphThreadMessage>({ token, path });
  } catch {
    return undefined;
  }
}

/**
 * Fetch thread replies for a channel message, ordered chronologically.
 *
 * The Graph API replies endpoint (`/messages/{id}/replies`) does not support
 * `$orderby`, so results are always returned in ascending (oldest-first) order.
 * When a thread has more than `limit` replies, this function paginates through
 * all pages via `fetchAllGraphPages` and returns the newest `limit` replies
 * (sorted chronologically), so the agent sees the most relevant recent context.
 *
 * Pagination is bounded by `MAX_REPLY_PAGES` (50 pages × up to 50 per page = 2500 replies).
 */
export async function fetchThreadReplies(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  limit = 50,
): Promise<GraphThreadMessage[]> {
  const top = Math.min(Math.max(limit, 1), 50);
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${top}&$select=id,from,body,createdDateTime`;

  // Paginate through all reply pages, bounded by MAX_REPLY_PAGES (2500 total).
  const { items } = await fetchAllGraphPages<GraphThreadMessage>({
    token,
    path,
    maxPages: MAX_REPLY_PAGES,
  });

  // For threads with ≤ limit replies, return as-is (chronological).
  if (items.length <= limit) {
    return items;
  }

  // Select newest `limit` replies by createdDateTime, then restore chronological order.
  // Items without createdDateTime are treated as oldest (sorted to the front).
  const sorted = [...items].sort((a, b) =>
    (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""),
  );
  return sorted.slice(0, limit).sort((a, b) =>
    (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""),
  );
}

/**
 * Format thread messages into a context string for the agent.
 * Skips the current message (by id) and blank messages.
 */
export function formatThreadContext(
  messages: GraphThreadMessage[],
  currentMessageId?: string,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.id && msg.id === currentMessageId) {
      continue;
    } // Skip the triggering message.
    const sender = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? "unknown";
    const contentType = msg.body?.contentType ?? "text";
    const rawContent = msg.body?.content ?? "";
    const content =
      contentType === "html" ? stripHtmlFromTeamsMessage(rawContent) : rawContent.trim();
    if (!content) {
      continue;
    }
    lines.push(`${sender}: ${content}`);
  }
  return lines.join("\n");
}

// Exported for testing only.
export { teamGroupIdCache as _teamGroupIdCacheForTest };
