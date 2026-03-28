import { fetchGraphJson, postGraphJson, type GraphResponse } from "./graph.js";

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

type GraphPagedResponse<T> = GraphResponse<T> & {
  "@odata.nextLink"?: string;
};

type GraphBatchResponse<T> = {
  responses?: Array<{
    id?: string;
    status?: number;
    body?: T;
  }>;
};

const GRAPH_BATCH_MAX_REQUESTS = 20;

// Graph team ids are Azure AD group ids. We keep this check intentionally broad
// because some tenants surface uppercase GUIDs and Graph ids are the only raw
// team ids we can safely reuse without another directory lookup.
export function looksLikeGraphTeamId(value: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(value.trim());
}

function graphPathFromNextLink(nextLink: string): string | null {
  try {
    const url = new URL(nextLink);
    // Graph nextLink values already include the API version (`/v1.0/...` or
    // `/beta/...`). Strip that prefix so fetchGraphJson can prepend GRAPH_ROOT
    // exactly once instead of producing `/v1.0/v1.0/...` URLs on later pages.
    const pathWithoutVersion = url.pathname.replace(/^\/(?:v\d+(?:\.\d+)*|beta)\b/, "");
    return `${pathWithoutVersion}${url.search}`;
  } catch {
    return null;
  }
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function findGraphTeamIdByPrimaryChannel(params: {
  token: string;
  conversationTeamId: string;
  candidateTeamIds: string[];
}): Promise<string | null> {
  for (const teamIds of chunkArray(params.candidateTeamIds, GRAPH_BATCH_MAX_REQUESTS)) {
    const response = await postGraphJson<GraphBatchResponse<{ id?: string }>>({
      token: params.token,
      path: "/$batch",
      body: {
        requests: teamIds.map((graphTeamId, index) => ({
          id: String(index),
          method: "GET",
          url: `/teams/${encodeURIComponent(graphTeamId)}/primaryChannel?$select=id`,
        })),
      },
    });
    const responses = new Map(
      (response.responses ?? []).map((entry) => [entry.id ?? "", entry] as const),
    );
    for (const [index, graphTeamId] of teamIds.entries()) {
      const candidate = responses.get(String(index));
      const primaryId = candidate?.status === 200 ? candidate.body?.id?.trim() : undefined;
      if (primaryId && primaryId === params.conversationTeamId) {
        return graphTeamId;
      }
    }
  }
  return null;
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

  // First try the cheap path: some tenants already expose a Graph-usable team
  // id in channelData.team.id, so `/teams/{id}` succeeds directly.
  try {
    const path = `/teams/${encodeURIComponent(conversationTeamId)}?$select=id`;
    const team = await fetchGraphJson<{ id?: string }>({ token, path });
    const confirmedGroupId = team.id?.trim();
    if (confirmedGroupId) {
      teamGroupIdCache.set(conversationTeamId, {
        groupId: confirmedGroupId,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return confirmedGroupId;
    }
  } catch {
    // Ignore and fall through to the Graph-id / pagination paths below.
  }

  // Preserve the pre-parity behavior for callers that already have a Graph team
  // id. We intentionally do not cache the raw id here because a failed lookup on
  // `/teams/{id}` can also mean the input was a Bot Framework team key.
  if (looksLikeGraphTeamId(conversationTeamId)) {
    return conversationTeamId;
  }

  // Bot Framework commonly gives us the runtime team key (matching the primary
  // channel id) instead of the Graph group id. Recover the Graph team id by
  // scanning teams until one reports this primary channel id. This path is more
  // expensive and directory-scope-dependent, so keep it as the last fallback.
  try {
    let path = `/groups?$filter=${encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')")}&$select=id&$top=999`;
    while (path) {
      const teams = await fetchGraphJson<GraphPagedResponse<{ id?: string }>>({ token, path });
      const graphTeamId = await findGraphTeamIdByPrimaryChannel({
        token,
        conversationTeamId,
        candidateTeamIds: (teams.value ?? [])
          .map((candidate) => candidate.id?.trim())
          .filter((value): value is string => Boolean(value)),
      });
      if (graphTeamId) {
        teamGroupIdCache.set(conversationTeamId, {
          groupId: graphTeamId,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return graphTeamId;
      }
      path = teams["@odata.nextLink"]
        ? (graphPathFromNextLink(teams["@odata.nextLink"]) ?? "")
        : "";
    }
  } catch {
    // Ignore and fail closed below.
  }

  throw new Error(`Unable to resolve Graph team id for Teams team key ${conversationTeamId}`);
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
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${top}&$select=id,from,body,createdDateTime`;
  const res = await fetchGraphJson<GraphResponse<GraphThreadMessage>>({ token, path });
  return res.value ?? [];
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
    if (msg.id && msg.id === currentMessageId) continue; // Skip the triggering message.
    const sender = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? "unknown";
    const contentType = msg.body?.contentType ?? "text";
    const rawContent = msg.body?.content ?? "";
    const content =
      contentType === "html" ? stripHtmlFromTeamsMessage(rawContent) : rawContent.trim();
    if (!content) continue;
    lines.push(`${sender}: ${content}`);
  }
  return lines.join("\n");
}

// Exported for testing only.
export { teamGroupIdCache as _teamGroupIdCacheForTest };
