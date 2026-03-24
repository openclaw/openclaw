import type { MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

export type GraphUser = {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
};

export type GraphGroup = {
  id?: string;
  displayName?: string;
};

export type GraphChannel = {
  id?: string;
  displayName?: string;
};

export type GraphResponse<T> = { value?: T[] };

export function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

export function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

export async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${params.path}`, {
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      ...params.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

export async function resolveGraphToken(cfg: unknown): Promise<string> {
  const creds = resolveMSTeamsCredentials(
    (cfg as { channels?: { msteams?: unknown } })?.channels?.msteams as MSTeamsConfig | undefined,
  );
  if (!creds) {
    throw new Error("MS Teams credentials missing");
  }
  const { app } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = createMSTeamsTokenProvider(app);
  const graphTokenValue = await tokenProvider.getAccessToken("https://graph.microsoft.com");
  const accessToken = readAccessToken(graphTokenValue);
  if (!accessToken) {
    throw new Error("MS Teams graph token unavailable");
  }
  return accessToken;
}

export async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphGroup>>({ token, path });
  return res.value ?? [];
}

// Cache: conversation-style team ID → Azure AD group ID (TTL-based to avoid stale entries).
const TEAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const teamIdToGroupIdCache = new Map<string, { groupId: string; expiresAt: number }>();

/**
 * Resolve the Azure AD group ID from a Teams conversation-style team ID (19:xxx@thread.tacv2).
 * Graph API endpoints need the group GUID, not the conversation ID.
 * Paginates through all groups and caches results with a TTL.
 */
export async function resolveTeamGroupId(
  token: string,
  conversationTeamId: string,
): Promise<string | null> {
  const cached = teamIdToGroupIdCache.get(conversationTeamId);
  if (cached && cached.expiresAt > Date.now()) {
    // Negative cache: null groupId means lookup already failed recently
    return cached.groupId || null;
  }

  // Paginate through all teams and match by internalId
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team')`;
  let nextPath: string | null =
    `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName&$top=100`;

  type GroupPage = GraphResponse<GraphGroup> & { "@odata.nextLink"?: string };

  while (nextPath) {
    const pagePath = nextPath;
    const page: GroupPage = await fetchGraphJson<GroupPage>({ token, path: pagePath });
    const groups: GraphGroup[] = page.value ?? [];

    // Resolve internalId for each group in parallel (batched)
    const results = await Promise.all(
      groups
        .filter((g: GraphGroup) => g.id)
        .map(async (group: GraphGroup) => {
          try {
            const teamPath = `/teams/${encodeURIComponent(group.id!)}?$select=id,internalId`;
            return await fetchGraphJson<{ id?: string; internalId?: string }>({
              token,
              path: teamPath,
            });
          } catch {
            return null; // Skip teams we can't access
          }
        }),
    );

    for (const teamInfo of results) {
      if (!teamInfo?.internalId || !teamInfo.id) continue;
      const groupId = groups.find((g: GraphGroup) => g.id === teamInfo.id)?.id;
      if (!groupId) continue;
      teamIdToGroupIdCache.set(teamInfo.internalId, {
        groupId,
        expiresAt: Date.now() + TEAM_CACHE_TTL_MS,
      });
      if (teamInfo.internalId === conversationTeamId) {
        return groupId;
      }
    }

    // Follow pagination link — strip the Graph root since fetchGraphJson prepends it
    const rawNext = page["@odata.nextLink"];
    nextPath = rawNext ? rawNext.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
  }
  // Cache the miss to avoid re-scanning on every message
  teamIdToGroupIdCache.set(conversationTeamId, {
    groupId: "",
    expiresAt: Date.now() + TEAM_CACHE_TTL_MS,
  });
  return null;
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}

export type GraphThreadMessage = {
  id?: string;
  from?: { user?: { displayName?: string; id?: string } };
  body?: { content?: string; contentType?: string };
  createdDateTime?: string;
};

/**
 * Fetch the parent message of a channel thread.
 */
export async function fetchChannelMessage(params: {
  token: string;
  teamId: string;
  channelId: string;
  messageId: string;
}): Promise<GraphThreadMessage | null> {
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}`;
  try {
    return await fetchGraphJson<GraphThreadMessage>({ token: params.token, path });
  } catch {
    return null;
  }
}

/**
 * Fetch all replies in a channel thread, paginating through results.
 * Uses `top` as page size (default 50) and follows `@odata.nextLink`.
 */
export async function fetchThreadReplies(params: {
  token: string;
  teamId: string;
  channelId: string;
  messageId: string;
  top?: number;
}): Promise<GraphThreadMessage[]> {
  const pageSize = params.top ?? 50;
  const basePath = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/replies`;
  type ReplyPage = GraphResponse<GraphThreadMessage> & { "@odata.nextLink"?: string };

  const allReplies: GraphThreadMessage[] = [];
  let nextPath: string | null =
    `${basePath}?$top=${pageSize}&$orderby=${encodeURIComponent("createdDateTime asc")}`;

  try {
    while (nextPath) {
      const pagePath = nextPath;
      const page: ReplyPage = await fetchGraphJson<ReplyPage>({
        token: params.token,
        path: pagePath,
      });
      allReplies.push(...(page.value ?? []));

      const rawNext = page["@odata.nextLink"];
      nextPath = rawNext ? rawNext.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
    }
  } catch {
    // Return whatever we collected so far
  }
  return allReplies;
}

/**
 * Strip HTML tags from Teams message body content for thread context display.
 * Unlike `stripMSTeamsMentionTags` (in inbound.ts) which removes @mention text entirely
 * for bot command parsing, this preserves mention display names so thread context
 * retains who was mentioned.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<at[^>]*>(.*?)<\/at>/gi, "$1")
    .replace(/<\/(?:div|p|br|li|tr)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
