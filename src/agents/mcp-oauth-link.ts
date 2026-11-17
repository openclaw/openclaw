import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOperatorMcpOAuthConnection } from "../plugins/mcp-auth-status.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthPendingAuthorization, readMcpOAuthStore } from "./mcp-oauth-store.js";
import { completeOAuthCallback, startMcpOAuthAuthorization } from "./mcp-oauth.js";
import type { ResolvedHttpMcpTransportConfig } from "./mcp-transport-config.js";

export const MCP_OAUTH_LINK_CALLBACK_PATH = "/oauth/mcp/callback";

export function resolveMcpOAuthLinkRedirectUrl(cfg: OpenClawConfig): string {
  return `${resolveGatewayPublicOrigin(cfg) ?? `http://127.0.0.1:${resolveGatewayPort(cfg)}`}${MCP_OAUTH_LINK_CALLBACK_PATH}`;
}

export type McpOAuthLinkStart =
  | { status: "authorized"; serverName: string }
  | {
      status: "redirect";
      serverName: string;
      authorizationUrl: string;
      redirectUrl: string;
      usesPublicOrigin: boolean;
    };

type ConnectionParams = {
  cfg: OpenClawConfig;
  metadata?: PluginMetadataSnapshot;
  serverName: string;
};

type SharedConnection = { config: ResolvedHttpMcpTransportConfig };

function resolveConnection(params: ConnectionParams, resolved?: SharedConnection) {
  try {
    const connection =
      resolved ??
      resolveOperatorMcpOAuthConnection({
        config: params.cfg,
        metadata: params.metadata,
        serverName: params.serverName,
      });
    if (connection) {
      return {
        config: connection.config,
        identity: operatorMcpOAuthIdentity(params.serverName, connection.config.url, params.cfg),
      };
    }
  } catch {
    throw new Error("MCP connection settings could not be read. Review the server settings.");
  }
  throw new Error(
    "This MCP server has no shared OAuth sign-in. Check its name and OAuth settings; per-requester servers connect through the channel.",
  );
}

/** Start or reuse a shared sign-in. The existing OAuth owner holds the credential lease. */
export async function startOperatorMcpOAuthLink(
  params: ConnectionParams & { assertCurrent?: () => void },
  connection?: SharedConnection,
): Promise<McpOAuthLinkStart> {
  const { identity, config } = resolveConnection(params, connection);
  const redirectUrl = resolveMcpOAuthLinkRedirectUrl(params.cfg);
  try {
    params.assertCurrent?.();
    const stored = await readMcpOAuthStore(identity.storeKey);
    const state = URL.parse(stored.lastAuthorizationUrl ?? "")?.searchParams.get("state");
    params.assertCurrent?.();
    const pending =
      state &&
      stored.redirectUrl === redirectUrl &&
      stored.codeVerifier &&
      (await readMcpOAuthPendingAuthorization(state)) === identity.storeKey;
    params.assertCurrent?.();
    const result =
      pending && stored.lastAuthorizationUrl
        ? { status: "redirect" as const, authorizationUrl: stored.lastAuthorizationUrl }
        : await startMcpOAuthAuthorization(identity, config, { redirectUrl });
    params.assertCurrent?.();
    if (result.status === "authorized") {
      return { status: "authorized", serverName: params.serverName };
    }
    return {
      status: "redirect",
      serverName: params.serverName,
      authorizationUrl: result.authorizationUrl,
      redirectUrl,
      usesPublicOrigin: Boolean(resolveGatewayPublicOrigin(params.cfg)),
    };
  } catch {
    throw new Error("MCP sign-in could not be started. Try connecting again.");
  }
}

/** Complete only a link-flow callback for this shared identity, never a Settings attempt. */
export async function completeOperatorMcpOAuthLink(
  params: ConnectionParams & { callbackUrl: string },
  connection?: SharedConnection,
): Promise<"authorized" | "expired"> {
  const { identity, config } = resolveConnection(params, connection);
  const callback = URL.parse(params.callbackUrl);
  if (
    !callback ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.searchParams.has("error") ||
    callback.searchParams.getAll("state").length !== 1 ||
    callback.searchParams.getAll("code").length !== 1 ||
    callback.searchParams.getAll("iss").length > 1
  ) {
    throw new Error("Paste the complete MCP sign-in redirect URL from your browser.");
  }
  const state = callback.searchParams.get("state")?.trim();
  const code = callback.searchParams.get("code")?.trim();
  if (!state || !code) {
    throw new Error("Paste the complete MCP sign-in redirect URL from your browser.");
  }
  try {
    const stored = await readMcpOAuthStore(identity.storeKey);
    const redirect = URL.parse(stored.redirectUrl ?? "");
    if (
      redirect?.pathname !== MCP_OAUTH_LINK_CALLBACK_PATH ||
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      (await readMcpOAuthPendingAuthorization(state)) !== identity.storeKey
    ) {
      return "expired";
    }
    const iss = callback.searchParams.get("iss");
    return await completeOAuthCallback(identity, config, {
      code,
      state,
      ...(iss === null ? {} : { iss }),
    });
  } catch {
    throw new Error("MCP sign-in could not be completed. Try connecting again.");
  }
}
