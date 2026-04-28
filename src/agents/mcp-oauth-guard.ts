import { isMcpConfigRecord } from "./mcp-config-shared.js";

export type HttpMcpOAuthGuardResult =
  | {
      ok: true;
      warnings: string[];
    }
  | {
      ok: false;
      reason: string;
    };

type OAuthResourceHints = {
  resource?: string;
  audience?: string;
  protectedResourceMetadataUrl?: string;
};

function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOAuthResourceHints(rawServer: unknown): OAuthResourceHints {
  if (!isMcpConfigRecord(rawServer) || !isMcpConfigRecord(rawServer.oauth)) {
    return {};
  }
  return {
    resource: normalizeOptionalString(rawServer.oauth.resource),
    audience: normalizeOptionalString(rawServer.oauth.audience),
    protectedResourceMetadataUrl: normalizeOptionalString(
      rawServer.oauth.protectedResourceMetadataUrl,
    ),
  };
}

function validateSameOriginUrl(params: {
  label: string;
  value: string;
  serverUrl: URL;
}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(params.value);
  } catch {
    return `${params.label} must be an absolute URL`;
  }
  if (parsed.origin !== params.serverUrl.origin) {
    return `${params.label} origin ${parsed.origin} does not match MCP server origin ${params.serverUrl.origin}`;
  }
  return null;
}

/**
 * Guard remote HTTP MCP bearer-token configuration before broader external MCP expansion.
 *
 * We cannot introspect opaque bearer tokens locally, so OpenClaw requires any configured OAuth
 * resource/audience hints to be same-origin with the MCP resource server and warns when bearer
 * auth is present without those hints. The warnings intentionally mention only origins/header
 * names, never configured token material.
 */
export function evaluateHttpMcpOAuthGuard(params: {
  url: string;
  headers?: Record<string, string>;
  rawServer: unknown;
}): HttpMcpOAuthGuardResult {
  const serverUrl = new URL(params.url);
  const authorization = getHeaderValue(params.headers, "authorization");
  const isBearerAuthorization = /^Bearer\s+\S+/i.test(authorization ?? "");
  const hints = readOAuthResourceHints(params.rawServer);

  for (const [label, value] of [
    ["mcp.oauth.resource", hints.resource],
    ["mcp.oauth.audience", hints.audience],
    ["mcp.oauth.protectedResourceMetadataUrl", hints.protectedResourceMetadataUrl],
  ] as const) {
    if (!value) {
      continue;
    }
    const invalid = validateSameOriginUrl({ label, value, serverUrl });
    if (invalid) {
      return { ok: false, reason: invalid };
    }
  }

  const warnings: string[] = [];
  if (isBearerAuthorization && !hints.resource && !hints.audience) {
    warnings.push(
      `remote MCP server ${serverUrl.origin} uses bearer Authorization without mcp.oauth.resource or mcp.oauth.audience; token resource/audience binding cannot be verified`,
    );
  }
  if (authorization && !isBearerAuthorization) {
    warnings.push(
      `remote MCP server ${serverUrl.origin} uses non-bearer Authorization; verify the auth mode is intentionally allowlisted before external expansion`,
    );
  }
  return { ok: true, warnings };
}
