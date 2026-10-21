import {
  CrossAppAccessProvider,
  discoverAndRequestJwtAuthGrant,
  type FetchLike,
} from "@modelcontextprotocol/client";
import * as oidc from "openid-client";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { withMcpOAuthLeaseSignal } from "./mcp-oauth-provider.js";
import { mutateMcpOAuthStore, readMcpOAuthStore } from "./mcp-oauth-store.js";

class PostAuthenticatedCrossAppAccessProvider extends CrossAppAccessProvider {
  override get clientMetadata() {
    return { ...super.clientMetadata, token_endpoint_auth_method: "client_secret_post" as const };
  }

  override clientInformation() {
    return {
      ...super.clientInformation(),
      token_endpoint_auth_method: "client_secret_post" as const,
    };
  }
}

/** One operator's enterprise sign-in can authorize several configured MCP resources. */
export type McpEnterpriseConfig = {
  identity: "shared";
  idpIssuer: string;
  idpClientId: string;
  idpClientSecret: string;
  resourceIssuer: string;
  resourceClientId: string;
  resourceClientSecret: string;
  scope: string;
  redirectUrl: string;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
};

export function mcpEnterpriseIdpIdentity(config: McpEnterpriseConfig) {
  return operatorMcpOAuthIdentity("enterprise-sso", `${config.idpIssuer}\0${config.idpClientId}`);
}

export function mcpEnterpriseIdpStoreKey(config: McpEnterpriseConfig): string {
  return mcpEnterpriseIdpIdentity(config).storeKey;
}

/** Keep discovery, code exchange, and refresh on the caller's guarded fetch. */
export function discoverMcpEnterpriseIdp(config: McpEnterpriseConfig, fetchFn: FetchLike) {
  const oidcFetch: oidc.CustomFetch = (url, options) => {
    const { body, ...init } = options;
    // openid-client accepts Uint8Array<ArrayBufferLike>; RequestInit requires
    // an owned ArrayBuffer in the UI and declaration TypeScript projects.
    return fetchFn(url, {
      ...init,
      body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
    });
  };
  return oidc.discovery(
    new URL(config.idpIssuer),
    config.idpClientId,
    config.idpClientSecret,
    undefined,
    { [oidc.customFetch]: oidcFetch },
  );
}

/** A logout or a new IdP login invalidates resource tokens held by a live transport. */
export async function readMcpEnterpriseAuthorizationId(
  config: McpEnterpriseConfig,
): Promise<string> {
  const current = await readMcpOAuthStore(mcpEnterpriseIdpStoreKey(config));
  if (!current.authorizationId || !current.tokens?.id_token) {
    throw new Error('Enterprise SSO has expired. Run "openclaw mcp login <server>" again.');
  }
  return current.authorizationId;
}

/** Read the IdP assertion only at exchange time, never into a shared server catalog. */
async function readEnterpriseIdToken(
  config: McpEnterpriseConfig,
  fetchFn: FetchLike,
): Promise<string> {
  const storeKey = mcpEnterpriseIdpStoreKey(config);
  const current = await readMcpOAuthStore(storeKey);
  if (
    current.tokens?.id_token &&
    current.tokenExpiresAt &&
    current.tokenExpiresAt > Date.now() + 30_000
  ) {
    return current.tokens.id_token;
  }
  if (!current.tokens?.refresh_token) {
    throw new Error('Enterprise SSO has expired. Run "openclaw mcp login <server>" again.');
  }
  const context = captureOpenClawStateWorkerContext();
  return withOpenClawStateLeaseAsync(
    { scope: "core:mcp-oauth", key: storeKey, leaseMs: 60_000, waitMs: 30_000 },
    context,
    async (lease) => {
      const stored = await readMcpOAuthStore(storeKey, context);
      if (
        stored.tokens?.id_token &&
        stored.tokenExpiresAt &&
        stored.tokenExpiresAt > Date.now() + 30_000
      ) {
        return stored.tokens.id_token;
      }
      if (!stored.tokens?.refresh_token) {
        throw new Error('Enterprise SSO has expired. Run "openclaw mcp login <server>" again.');
      }
      const discovered = await discoverMcpEnterpriseIdp(
        config,
        withMcpOAuthLeaseSignal(fetchFn, lease.signal),
      );
      const refreshed = await oidc.refreshTokenGrant(discovered, stored.tokens.refresh_token);
      const expiresAt = refreshed.claims()?.exp;
      if (!refreshed.id_token || !expiresAt || expiresAt * 1000 <= Date.now() + 30_000) {
        throw new Error(
          'Enterprise SSO refresh returned no valid ID token. Run "openclaw mcp login <server>" again.',
        );
      }
      const result = await mutateMcpOAuthStore(
        { storeKey, lease, context },
        {
          kind: "tokens",
          tokens: {
            access_token: refreshed.access_token,
            token_type: refreshed.token_type,
            id_token: refreshed.id_token,
            refresh_token: refreshed.refresh_token ?? stored.tokens.refresh_token,
          },
          tokenExpiresAt: expiresAt * 1000,
        },
      );
      if (!result.applied) {
        throw new Error("Enterprise SSO refresh was not saved.");
      }
      return refreshed.id_token;
    },
  );
}

export function createMcpEnterpriseProvider(config: McpEnterpriseConfig, fetchFn: FetchLike) {
  const Provider =
    config.tokenEndpointAuthMethod === "client_secret_post"
      ? PostAuthenticatedCrossAppAccessProvider
      : CrossAppAccessProvider;
  return new Provider({
    clientId: config.resourceClientId,
    clientSecret: config.resourceClientSecret,
    expectedIssuer: config.resourceIssuer,
    fetchFn,
    assertion: async (context) => {
      const result = await discoverAndRequestJwtAuthGrant({
        idpUrl: config.idpIssuer,
        audience: context.authorizationServerUrl,
        resource: context.resourceUrl,
        scope: context.scope ?? config.scope,
        idToken: await readEnterpriseIdToken(config, fetchFn),
        clientId: config.idpClientId,
        clientSecret: config.idpClientSecret,
        fetchFn: context.fetchFn,
      });
      return result.jwtAuthGrant;
    },
  });
}
