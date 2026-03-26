import type { MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";

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

export async function postGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${params.path}`, {
    method: "POST",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph POST ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  // Some Graph mutation endpoints return 204 No Content
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function postGraphBetaJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await fetch(`${GRAPH_BETA}${params.path}`, {
    method: "POST",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph beta POST ${params.path} failed (${res.status}): ${text || "unknown error"}`,
    );
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function deleteGraphRequest(params: { token: string; path: string }): Promise<void> {
  const res = await fetch(`${GRAPH_ROOT}${params.path}`, {
    method: "DELETE",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph DELETE ${params.path} failed (${res.status}): ${text || "unknown error"}`,
    );
  }
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}
