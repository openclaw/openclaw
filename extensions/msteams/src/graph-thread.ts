import type { OpenClawConfig } from "../runtime-api.js";
import { fetchGraphJson, resolveGraphToken, type GraphResponse } from "./graph.js";

export type GraphThreadMessage = {
  id?: string;
  from?: {
    user?: { displayName?: string; id?: string };
    application?: { displayName?: string; id?: string };
  };
  body?: { content?: string; contentType?: string };
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    name?: string;
  }>;
  createdDateTime?: string;
};

type GraphThreadResponse = GraphResponse<GraphThreadMessage> & {
  "@odata.nextLink"?: string;
};

export type MSTeamsThreadMessage = {
  id?: string;
  senderId?: string;
  senderName: string;
  text: string;
  createdAt?: string;
  source: "root" | "reply";
};

export type ListThreadMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
  channelId: string;
  rootMessageId: string;
  limit?: number;
};

export type ListThreadMSTeamsResult = {
  teamId: string;
  channelId: string;
  rootMessageId: string;
  truncated: boolean;
  unavailableMediaCount: number;
  sourceIds: string[];
  messages: MSTeamsThreadMessage[];
};

// TTL cache for team ID -> group GUID mapping.
const teamGroupIdCache = new Map<string, { groupId: string; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Strip HTML tags from Teams message content, preserving @mention display names.
 * Teams wraps mentions in <at>Name</at> tags.
 */
export function stripHtmlFromTeamsMessage(html: string): string {
  // Preserve mention display names by replacing <at>Name</at> with @Name.
  let text = html.replace(/<at[^>]*>(.*?)<\/at>/gi, "@$1");
  // Strip remaining HTML tags.
  text = text.replace(/<[^>]*>/g, " ");
  // Decode common HTML entities.
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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
  if (cached && cached.expiresAt > Date.now()) {
    return cached.groupId;
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
    teamGroupIdCache.set(conversationTeamId, {
      groupId,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

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
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}?$select=id,from,body,attachments,createdDateTime`;
  try {
    return await fetchGraphJson<GraphThreadMessage>({ token, path });
  } catch {
    return undefined;
  }
}

/**
 * Fetch thread replies for a channel message, ordered chronologically.
 *
 * **Limitation:** The Graph API replies endpoint (`/messages/{id}/replies`) does not
 * support `$orderby`, so results are always returned in ascending (oldest-first) order.
 * Combined with the `$top` cap of 50, this means only the **oldest 50 replies** are
 * returned for long threads — newer replies are silently omitted. There is currently no
 * Graph API workaround for this; pagination via `@odata.nextLink` can retrieve more
 * replies but still in ascending order only.
 */
export async function fetchThreadReplies(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  limit = 50,
): Promise<GraphThreadMessage[]> {
  const top = Math.min(Math.max(limit, 1), 50);
  // NOTE: Graph replies endpoint returns oldest-first and does not support $orderby.
  // For threads with >50 replies, only the oldest 50 are returned. The most recent
  // replies (often the most relevant context) may be truncated.
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${top}&$select=id,from,body,attachments,createdDateTime`;
  const res = await fetchGraphJson<GraphResponse<GraphThreadMessage>>({ token, path });
  return res.value ?? [];
}

function normalizeThreadLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(Math.max(Math.floor(limit ?? 100), 1), 250);
}

function nextGraphPath(nextLink: string): string {
  try {
    const url = new URL(nextLink);
    return `${url.pathname}${url.search}`;
  } catch {
    return nextLink;
  }
}

function threadMessageText(message: GraphThreadMessage): string {
  const contentType = message.body?.contentType ?? "text";
  const rawContent = message.body?.content ?? "";
  const text = contentType === "html" ? stripHtmlFromTeamsMessage(rawContent) : rawContent.trim();
  if (text) {
    return text;
  }
  return countUnavailableMediaMarkers(message) > 0 ? "[media unavailable]" : "";
}

function threadMessageSender(message: GraphThreadMessage) {
  return {
    senderName:
      message.from?.user?.displayName ?? message.from?.application?.displayName ?? "unknown",
    senderId: message.from?.user?.id ?? message.from?.application?.id,
  };
}

function toThreadMessage(
  message: GraphThreadMessage,
  source: "root" | "reply",
): MSTeamsThreadMessage | null {
  const text = threadMessageText(message);
  if (!text) {
    return null;
  }
  const sender = threadMessageSender(message);
  return {
    ...(message.id ? { id: message.id } : {}),
    ...(sender.senderId ? { senderId: sender.senderId } : {}),
    senderName: sender.senderName,
    text,
    ...(message.createdDateTime ? { createdAt: message.createdDateTime } : {}),
    source,
  };
}

function countUnavailableMediaMarkers(message: GraphThreadMessage): number {
  const attachmentCount = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment) => {
        const contentType = attachment.contentType?.trim().toLowerCase() ?? "";
        const contentUrl = attachment.contentUrl?.trim() ?? "";
        const name = attachment.name?.trim() ?? "";
        return Boolean(contentType || contentUrl || name);
      }).length
    : 0;
  if (attachmentCount > 0) {
    return attachmentCount;
  }
  const contentType = message.body?.contentType ?? "text";
  const rawContent = message.body?.content ?? "";
  if (!rawContent || contentType !== "html") {
    return 0;
  }
  const matches = rawContent.match(/<(img|attachment)\b/gi);
  return matches?.length ?? 0;
}

function sortChronologically(messages: MSTeamsThreadMessage[]): MSTeamsThreadMessage[] {
  return messages.toSorted((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (leftValid !== rightValid) {
      return leftValid ? -1 : 1;
    }
    if (left.source !== right.source) {
      return left.source === "root" ? -1 : 1;
    }
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

export async function fetchThreadRepliesDetailed(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  limit = 100,
): Promise<{ messages: GraphThreadMessage[]; truncated: boolean }> {
  const targetLimit = normalizeThreadLimit(limit);
  const pageSize = Math.min(targetLimit, 50);
  let path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${pageSize}&$select=id,from,body,attachments,createdDateTime`;
  const messages: GraphThreadMessage[] = [];
  let truncated = false;

  while (path) {
    const response = await fetchGraphJson<GraphThreadResponse>({ token, path });
    const page = response.value ?? [];
    for (const entry of page) {
      if (messages.length >= targetLimit) {
        truncated = true;
        return { messages, truncated };
      }
      messages.push(entry);
    }
    const nextLink =
      typeof response["@odata.nextLink"] === "string" && response["@odata.nextLink"].trim()
        ? response["@odata.nextLink"].trim()
        : undefined;
    if (!nextLink) {
      break;
    }
    path = nextGraphPath(nextLink);
  }

  return { messages, truncated };
}

export async function listThreadMSTeams(
  params: ListThreadMSTeamsParams,
): Promise<ListThreadMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const groupId = await resolveTeamGroupId(token, params.teamId);
  const limit = normalizeThreadLimit(params.limit);
  const [rootMessage, replies] = await Promise.all([
    fetchChannelMessage(token, groupId, params.channelId, params.rootMessageId),
    fetchThreadRepliesDetailed(token, groupId, params.channelId, params.rootMessageId, limit),
  ]);
  const messages = sortChronologically(
    [
      ...(rootMessage ? [toThreadMessage(rootMessage, "root")] : []),
      ...replies.messages.map((message) => toThreadMessage(message, "reply")),
    ].filter((entry): entry is MSTeamsThreadMessage => Boolean(entry)),
  );
  const unavailableMediaCount =
    (rootMessage ? countUnavailableMediaMarkers(rootMessage) : 0) +
    replies.messages.reduce((total, message) => total + countUnavailableMediaMarkers(message), 0);

  return {
    teamId: params.teamId,
    channelId: params.channelId,
    rootMessageId: params.rootMessageId,
    truncated: replies.truncated,
    unavailableMediaCount,
    sourceIds: messages.map((message) => message.id).filter((id): id is string => Boolean(id)),
    messages,
  };
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
