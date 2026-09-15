/** MCP SDK OAuth provider backed by canonical OpenClaw state. */
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { createMcpOAuthProviderState } from "./mcp-oauth-provider-state.js";
import { readMcpOAuthStore, mutateMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";
import { MCP_OAUTH_DEFAULT_REDIRECT_URL } from "./mcp-oauth-store.mutations.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    MCP_OAUTH_DEFAULT_REDIRECT_URL
  );
}

function buildOAuthClientMetadata(
  config: McpOAuthConfig,
  store: McpOAuthStore = {},
): OAuthClientMetadata {
  const redirectUrl = resolveOAuthRedirectUrl(config, store);
  return {
    client_name: "OpenClaw MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(normalizeOptionalString(config.scope)
      ? { scope: normalizeOptionalString(config.scope) }
      : {}),
  };
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    return await baseFetch(url, { ...init, signal });
  };
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export async function createMcpOAuthClientProvider(params: {
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  lease: OpenClawStateAsyncLeaseContext;
  storeContext: OpenClawStateWorkerContext;
}): Promise<OAuthClientProvider> {
  const config = params.config ?? {};
  const storeKey = params.identity.storeKey;
  const storeContext = params.storeContext;
  const { readStore, updateStore, preparedStore } = createMcpOAuthProviderState({
    read: async () => {
      const store = await readMcpOAuthStore(storeKey, storeContext);
      await params.lease.assertOwned();
      return store;
    },
    mutate: (mutation) => mutateMcpOAuthStore(storeKey, mutation, params.lease, storeContext),
  });
  await readStore();
  const assertAuthorizationRedirectAllowed = () => {
    if (params.allowAuthorizationRedirect !== true) {
      throw new Error(
        `MCP server "${params.identity.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.identity.serverName}.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, preparedStore());
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, preparedStore());
    },
    state() {
      assertAuthorizationRedirectAllowed();
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    async clientInformation() {
      return (await readStore()).clientInformation;
    },
    async saveClientInformation(clientInformation) {
      await updateStore({ kind: "clientInformation", clientInformation });
    },
    async tokens() {
      if (params.suppressStoredTokens) {
        return undefined;
      }
      const store = await readStore();
      const discoveredAuthorizationServerUrl = store.discoveryState?.authorizationServerUrl;
      if (!store.tokens?.refresh_token || discoveredAuthorizationServerUrl === undefined) {
        return store.tokens;
      }
      return store.tokensAuthorizationServerUrl !== undefined &&
        discoveredAuthorizationServerUrl === store.tokensAuthorizationServerUrl
        ? store.tokens
        : undefined;
    },
    async saveTokens(tokens) {
      const tokenExpiresAt = resolveTokenExpiresAt(tokens);
      await updateStore({ kind: "tokens", tokens, tokenExpiresAt });
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      await updateStore({
        kind: "authorizationRedirect",
        authorizationUrl: authorizationUrl.toString(),
        redirectUrl: normalizeOptionalString(config.redirectUrl),
      });
    },
    async saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      await updateStore({ kind: "codeVerifier", codeVerifier });
    },
    async codeVerifier() {
      const codeVerifier = (await readStore()).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      await updateStore({
        kind: "invalidate",
        scope,
        suppressStoredTokens: params.suppressStoredTokens === true,
      });
    },
    async saveDiscoveryState(discoveryState) {
      await updateStore({ kind: "discoveryState", discoveryState });
    },
    async discoveryState() {
      return (await readStore()).discoveryState;
    },
  };
}
