/**
 * Auth-profile backed bearer injection for remote MCP servers.
 */
import crypto from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadAuthProfileStoreForSecretsRuntime, resolveApiKeyForProfile } from "./auth-profiles.js";

type McpAuthProfileOptions = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withoutAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Returns the refresh-capable auth profile selected for one MCP server. */
export function resolveMcpAuthProfileId(rawServer: unknown): string | undefined {
  if (!isRecord(rawServer) || rawServer.auth !== "oauth" || !isRecord(rawServer.oauth)) {
    return undefined;
  }
  const authProfileId = rawServer.oauth.authProfileId;
  return typeof authProfileId === "string" && authProfileId.trim().length > 0
    ? authProfileId.trim()
    : undefined;
}

async function resolveMcpAuthProfileBearerToken(
  params: {
    serverName: string;
    profileId: string;
  } & McpAuthProfileOptions,
): Promise<string> {
  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir, {
    config: params.cfg,
    externalCliProfileIds: [params.profileId],
  });
  const credential = store.profiles[params.profileId];
  if (!credential) {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but that profile was not found.`,
    );
  }
  if (credential.type !== "oauth") {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but ${credential.type} profiles are not refreshable. Use a refresh-capable OAuth profile.`,
    );
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.cfg,
    store,
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
  if (!resolved || resolved.profileType !== "oauth" || !resolved.apiKey) {
    throw new Error(
      `MCP server "${params.serverName}" could not resolve refreshable OAuth auth profile "${params.profileId}". Re-authenticate the profile and retry.`,
    );
  }
  return resolved.apiKey;
}

/** Wraps HTTP MCP fetch with same-origin, refreshed bearer injection. */
export function withMcpAuthProfileBearer(
  params: {
    fetchFn: FetchLike;
    serverName: string;
    resourceUrl: string;
    headers?: Record<string, string>;
    authProfileId: string;
  } & McpAuthProfileOptions,
): FetchLike {
  const resourceOrigin = new URL(params.resourceUrl).origin;
  const configuredHeaders = withoutAuthorizationHeader(params.headers);
  return async (url, init) => {
    if (new URL(url).origin !== resourceOrigin) {
      return params.fetchFn(url, init);
    }
    const headers = new Headers(configuredHeaders);
    for (const [key, value] of new Headers(init?.headers)) {
      if (key.toLowerCase() !== "authorization") {
        headers.set(key, value);
      }
    }
    const token = await resolveMcpAuthProfileBearerToken({
      serverName: params.serverName,
      profileId: params.authProfileId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    headers.set("authorization", `Bearer ${token}`);
    return params.fetchFn(url, { ...(init as RequestInit), headers });
  };
}

function buildTokenEnvVarName(serverName: string): string {
  const hash = crypto.createHash("sha256").update(serverName).digest("hex").slice(0, 12);
  return `OPENCLAW_MCP_AUTH_${hash.toUpperCase()}_TOKEN`;
}

function stripOpenClawOnlyOAuthConfig(server: BundleMcpServerConfig): BundleMcpServerConfig {
  const next = { ...server };
  delete next.auth;
  delete next.oauth;
  return next;
}

/** Resolves auth-profile backed MCP servers into env-backed bearer headers for CLI runtimes. */
export async function resolveMcpAuthProfileBundleConfig(
  params: {
    config: BundleMcpConfig;
    env?: Record<string, string>;
    tokenProjection?: "env" | "literal";
  } & McpAuthProfileOptions,
): Promise<{ config: BundleMcpConfig; env?: Record<string, string> }> {
  let nextServers: Record<string, BundleMcpServerConfig> | undefined;
  let nextEnv = params.env;
  const tokenProjection = params.tokenProjection ?? "env";

  for (const [serverName, server] of Object.entries(params.config.mcpServers)) {
    const authProfileId = resolveMcpAuthProfileId(server);
    if (!authProfileId) {
      continue;
    }

    const token = await resolveMcpAuthProfileBearerToken({
      serverName,
      profileId: authProfileId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    let authorization: string;
    if (tokenProjection === "literal") {
      authorization = `Bearer ${token}`;
    } else {
      const envVar = buildTokenEnvVarName(serverName);
      if (!nextEnv || nextEnv === params.env) {
        nextEnv = { ...params.env };
      }
      nextEnv[envVar] = token;
      authorization = `Bearer \${${envVar}}`;
    }
    const headers = withoutAuthorizationHeader(normalizeStringHeaders(server.headers));
    nextServers ??= { ...params.config.mcpServers };
    nextServers[serverName] = stripOpenClawOnlyOAuthConfig({
      ...server,
      headers: {
        ...headers,
        Authorization: authorization,
      },
    });
  }

  return {
    config: nextServers ? { mcpServers: nextServers } : params.config,
    env: nextEnv,
  };
}
