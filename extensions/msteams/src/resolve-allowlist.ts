import { GRAPH_ROOT } from "./attachments/shared.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

type GraphUser = {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
};

type GraphGroup = {
  id?: string;
  displayName?: string;
};

type GraphChannel = {
  id?: string;
  displayName?: string;
};

type GraphResponse<T> = { value?: T[] };

export type MSTeamsChannelResolution = {
  input: string;
  resolved: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  note?: string;
};

export type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

function readAccessToken(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const token =
      (value as { accessToken?: unknown }).accessToken ?? (value as { token?: unknown }).token;
    return typeof token === "string" ? token : null;
  }
  return null;
}

function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${params.path}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...(params.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

async function resolveGraphToken(cfg: unknown): Promise<string> {
  const creds = resolveMSTeamsCredentials((cfg as { channels?: { msteams?: unknown } })?.channels?.msteams);
  if (!creds) throw new Error("MS Teams credentials missing");
  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = new sdk.MsalTokenProvider(authConfig);
  const token = await tokenProvider.getAccessToken("https://graph.microsoft.com/.default");
  const accessToken = readAccessToken(token);
  if (!accessToken) throw new Error("MS Teams graph token unavailable");
  return accessToken;
}

function parseTeamChannelInput(raw: string): { team?: string; channel?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parts = trimmed.split("/");
  const team = parts[0]?.trim();
  const channel = parts.length > 1 ? parts.slice(1).join("/").trim() : undefined;
  return { team: team || undefined, channel: channel || undefined };
}

async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphGroup>>({ token, path });
  return res.value ?? [];
}

async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}

export async function resolveMSTeamsChannelAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsChannelResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  const results: MSTeamsChannelResolution[] = [];

  for (const input of params.entries) {
    const { team, channel } = parseTeamChannelInput(input);
    if (!team) {
      results.push({ input, resolved: false });
      continue;
    }
    const teams =
      /^[0-9a-fA-F-]{16,}$/.test(team) ? [{ id: team, displayName: team }] : await listTeamsByName(token, team);
    if (teams.length === 0) {
      results.push({ input, resolved: false, note: "team not found" });
      continue;
    }
    const teamMatch = teams[0];
    const teamId = teamMatch.id?.trim();
    const teamName = teamMatch.displayName?.trim() || team;
    if (!teamId) {
      results.push({ input, resolved: false, note: "team id missing" });
      continue;
    }
    if (!channel) {
      results.push({
        input,
        resolved: true,
        teamId,
        teamName,
        note: teams.length > 1 ? "multiple teams; chose first" : undefined,
      });
      continue;
    }
    const channels = await listChannelsForTeam(token, teamId);
    const channelMatch =
      channels.find((item) => item.id === channel) ??
      channels.find(
        (item) => item.displayName?.toLowerCase() === channel.toLowerCase(),
      ) ??
      channels.find(
        (item) => item.displayName?.toLowerCase().includes(channel.toLowerCase() ?? ""),
      );
    if (!channelMatch?.id) {
      results.push({ input, resolved: false, note: "channel not found" });
      continue;
    }
    results.push({
      input,
      resolved: true,
      teamId,
      teamName,
      channelId: channelMatch.id,
      channelName: channelMatch.displayName ?? channel,
      note: channels.length > 1 ? "multiple channels; chose first" : undefined,
    });
  }

  return results;
}

export async function resolveMSTeamsUserAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsUserResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  const results: MSTeamsUserResolution[] = [];

  for (const input of params.entries) {
    const query = normalizeQuery(input);
    if (!query) {
      results.push({ input, resolved: false });
      continue;
    }
    if (/^[0-9a-fA-F-]{16,}$/.test(query)) {
      results.push({ input, resolved: true, id: query });
      continue;
    }
    let users: GraphUser[] = [];
    if (query.includes("@")) {
      const escaped = escapeOData(query);
      const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
      const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
      const res = await fetchGraphJson<GraphResponse<GraphUser>>({ token, path });
      users = res.value ?? [];
    } else {
      const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=10`;
      const res = await fetchGraphJson<GraphResponse<GraphUser>>({
        token,
        path,
        headers: { ConsistencyLevel: "eventual" },
      });
      users = res.value ?? [];
    }
    const match = users[0];
    if (!match?.id) {
      results.push({ input, resolved: false });
      continue;
    }
    results.push({
      input,
      resolved: true,
      id: match.id,
      name: match.displayName ?? undefined,
      note: users.length > 1 ? "multiple matches; chose first" : undefined,
    });
  }

  return results;
}
