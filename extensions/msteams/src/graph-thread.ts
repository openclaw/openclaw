// Msteams plugin module implements graph thread behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
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

// Successful lookups use a 10-minute TTL and a 500-entry insertion-order cap.
// Pruning after insert evicts the oldest team IDs before this process cache grows unbounded.
const teamGroupIdCache = new Map<string, { groupId: string; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TEAM_GROUP_ID_CACHE_MAX_ENTRIES = 500;

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
      pruneMapToMaxSize(teamGroupIdCache, TEAM_GROUP_ID_CACHE_MAX_ENTRIES);
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
 * Fetch a single chat message's full text via Graph and return plain text.
 *
 * Used to recover the complete quoted message for Teams quote replies: the
 * inbound blockquote only carries a Teams-truncated `preview` snippet. The
 * app-only `GET /chats/{chatId}/messages/{messageId}` endpoint IS permitted
 * with the `Chat.Read.All` application permission (unlike the delegated
 * `/me/chats` listing used by `resolveGraphChatId`, which 400s app-only).
 *
 * Returns undefined on any failure so callers degrade to the truncated preview.
 */
export async function fetchChatMessageText(
  token: string,
  chatId: string,
  messageId: string,
): Promise<string | undefined> {
  // The get-chatMessage endpoint does not support OData query params (e.g.
  // `$select`); tenants that enforce the documented contract reject the request,
  // which would silently fall back to the truncated preview. Request it plainly.
  const path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
  try {
    const msg = await fetchGraphJson<GraphThreadMessage>({ token, path });
    const raw = msg.body?.content ?? "";
    const text = msg.body?.contentType === "html" ? stripHtmlFromTeamsMessage(raw) : raw.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch thread replies for a channel message, ordered chronologically.
 *
 * The Graph API replies endpoint (`/messages/{id}/replies`) does not support
 * `$orderby`, so results are always returned in ascending (oldest-first) order.
 * When a thread has more than `maxReplies` replies, this function paginates through
 * all pages via `fetchAllGraphPages` and returns the newest `maxReplies` replies
 * (sorted chronologically, clamped to a maximum of 50), so the agent sees the
 * most relevant recent context.
 *
 * Pagination is bounded by `MAX_REPLY_PAGES` (50 pages × up to 50 per page = 2500 replies).
 * @param maxReplies - Desired number of replies (capped at 50, minimum 1). Defaults to 50.
 */
export async function fetchThreadReplies(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  maxReplies = 50,
): Promise<GraphThreadMessage[]> {
  // Always fetch full 50-item pages to ensure we get the newest replies when paginating.
  // The final result is sliced to the requested maxReplies after selecting newest replies.
  const top = Math.min(Math.max(maxReplies, 1), 50);
  const pageTop = 50; // Always fetch full pages to maximize pagination efficiency

  // NOTE: Graph replies endpoint returns oldest-first and does not support $orderby.
  // When a thread has more than `top` replies, this function paginates through
  // all pages via `fetchAllGraphPages` and returns the newest `top` replies
  // (sorted chronologically), so the agent sees the most relevant recent context.
  // Pagination is bounded by `MAX_REPLY_PAGES` (50 pages × up to 50 per page = 2500 replies).
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${pageTop}&$select=id,from,body,createdDateTime`;

  // Paginate through all reply pages, bounded by MAX_REPLY_PAGES (2500 total).
  const { items } = await fetchAllGraphPages<GraphThreadMessage>({
    token,
    path,
    maxPages: MAX_REPLY_PAGES,
  });

  // For threads with ≤ top replies, return as-is (chronological).
  if (items.length <= top) {
    return items;
  }

  // Select newest `top` replies by createdDateTime, then restore chronological order.
  // Items without createdDateTime are treated as oldest (sorted to the front).
  const sorted = items.toSorted((a, b) =>
    (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""),
  );
  return sorted
    .slice(0, top)
    .toSorted((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""));
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
