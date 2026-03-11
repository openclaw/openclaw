import type { MSTeamsConfig } from "openclaw/plugin-sdk/msteams";
import { GRAPH_ROOT } from "./attachments/shared.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";

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
  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = new sdk.MsalTokenProvider(authConfig);
  const token = await tokenProvider.getAccessToken("https://graph.microsoft.com");
  const accessToken = readAccessToken(token);
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

// Cache: conversation-style team ID → Azure AD group ID
const teamIdToGroupIdCache = new Map<string, string>();

/**
 * Resolve the Azure AD group ID from a Teams conversation-style team ID (19:xxx@thread.tacv2).
 * Graph API endpoints need the group GUID, not the conversation ID.
 */
export async function resolveTeamGroupId(token: string, conversationTeamId: string): Promise<string | null> {
  const cached = teamIdToGroupIdCache.get(conversationTeamId);
  if (cached) return cached;

  // List all teams and match by internalId
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const groups = await fetchGraphJson<GraphResponse<GraphGroup>>({ token, path });
  for (const group of groups.value ?? []) {
    if (!group.id) continue;
    try {
      const teamPath = `/teams/${encodeURIComponent(group.id)}?$select=id,internalId`;
      const teamInfo = await fetchGraphJson<{ id?: string; internalId?: string }>({ token, path: teamPath });
      if (teamInfo.internalId) {
        teamIdToGroupIdCache.set(teamInfo.internalId, group.id);
        if (teamInfo.internalId === conversationTeamId) {
          return group.id;
        }
      }
    } catch {
      // Skip teams we can't access
    }
  }
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
 * Fetch replies in a channel thread (up to `top` messages, default 50).
 */
export async function fetchThreadReplies(params: {
  token: string;
  teamId: string;
  channelId: string;
  messageId: string;
  top?: number;
}): Promise<GraphThreadMessage[]> {
  const limit = params.top ?? 50;
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/replies?$top=${limit}&$orderby=createdDateTime asc`;
  try {
    const res = await fetchGraphJson<GraphResponse<GraphThreadMessage>>({ token: params.token, path });
    return res.value ?? [];
  } catch {
    return [];
  }
}

/**
 * Strip HTML tags from Teams message body content.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<at[^>]*>.*?<\/at>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
