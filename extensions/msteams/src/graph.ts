import type { OpenClawConfig, MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { looksLikeGraphTeamId, resolveTeamGroupId } from "./graph-thread.js";

const GRAPH_BETA = "https://graph.microsoft.com/beta";
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

export type GraphPrimaryChannel = {
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

async function requestGraph(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  root?: string;
  headers?: Record<string, string>;
  body?: unknown;
  errorPrefix?: string;
}): Promise<Response> {
  const hasBody = params.body !== undefined;
  const res = await fetch(`${params.root ?? GRAPH_ROOT}${params.path}`, {
    method: params.method,
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...params.headers,
    },
    body: hasBody ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${params.errorPrefix ?? "Graph"} ${params.path} failed (${res.status}): ${text || "unknown error"}`,
    );
  }
  return res;
}

async function readOptionalGraphJson<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    headers: params.headers,
  });
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

export async function postGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    body: params.body,
    errorPrefix: "Graph POST",
  });
  return readOptionalGraphJson<T>(res);
}

export async function postGraphBetaJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    root: GRAPH_BETA,
    body: params.body,
    errorPrefix: "Graph beta POST",
  });
  return readOptionalGraphJson<T>(res);
}

export async function patchGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    method: "PATCH",
    body: params.body,
    errorPrefix: "Graph PATCH",
  });
  return readOptionalGraphJson<T>(res);
}

export async function deleteGraphRequest(params: { token: string; path: string }): Promise<void> {
  await requestGraph({
    token: params.token,
    path: params.path,
    method: "DELETE",
    errorPrefix: "Graph DELETE",
  });
}

export async function getPrimaryChannelForTeam(
  token: string,
  teamId: string,
): Promise<GraphPrimaryChannel | null> {
  const path = `/teams/${encodeURIComponent(teamId)}/primaryChannel?$select=id,displayName`;
  return await fetchGraphJson<GraphPrimaryChannel>({ token, path });
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}

function normalizeStoredConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

async function resolveStoredChannelTarget(
  to: string,
): Promise<{ teamId: string; channelId: string } | null> {
  // Teams plugin/runtime targets come through in two shapes here:
  //   1) `conversation:<stored-bot-framework-id>` for known conversations
  //   2) `conversation:<team-key>/<channel-id>` for explicit channel targets
  // Normalize both before consulting the conversation store so channel rename
  // keeps working for bound conversations and explicit one-off targets.
  const trimmed = to.trim();
  const cleaned = trimmed.startsWith("conversation:")
    ? trimmed.slice("conversation:".length).trim()
    : trimmed;
  if (cleaned.includes("/")) {
    const [teamId, channelId] = cleaned.split("/", 2);
    if (teamId?.trim() && channelId?.trim()) {
      return { teamId: teamId.trim(), channelId: channelId.trim() };
    }
  }

  const conversationId = cleaned;
  if (!conversationId) {
    return null;
  }

  const store = createMSTeamsConversationStoreFs();
  const reference = await store.get(normalizeStoredConversationId(conversationId));
  const teamId = reference?.teamId?.trim();
  const channelId = reference?.graphChannelId?.trim();
  const conversationType = reference?.conversation?.conversationType?.toLowerCase();
  if (conversationType !== "channel" || !teamId || !channelId) {
    return null;
  }

  return { teamId, channelId };
}

export async function editChannelMSTeams(params: {
  cfg: OpenClawConfig;
  to: string;
  name: string;
}): Promise<{ ok: true; teamId: string; channelId: string }> {
  const target = await resolveStoredChannelTarget(params.to);
  if (!target) {
    throw new Error(
      "msteams channel rename requires a stored channel conversation with teamId and graphChannelId",
    );
  }
  const token = await resolveGraphToken(params.cfg);
  // The stored/explicit Teams team id may still be the inbound Bot Framework
  // team key. Graph channel PATCH requires the Azure AD group/team id instead,
  // so translate before issuing the rename request.
  const resolvedTeamId = await resolveTeamGroupId(token, target.teamId);
  if (!looksLikeGraphTeamId(resolvedTeamId)) {
    throw new Error(
      "msteams channel rename requires a Graph team id; team lookup did not produce a usable Graph id",
    );
  }
  await patchGraphJson<void>({
    token,
    path: `/teams/${encodeURIComponent(resolvedTeamId)}/channels/${encodeURIComponent(target.channelId)}`,
    body: { displayName: params.name },
  });
  return { ok: true, teamId: resolvedTeamId, channelId: target.channelId };
}
