/** MCP SDK OAuth provider backed by canonical OpenClaw state. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore, updateMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

export type McpOAuthLoginLifecycle = {
  signal: AbortSignal;
  assertCurrent: () => void;
  onAuthorizationPublished: (state: string) => void;
  beforeTokensSaved: () => void;
  onTokensSaved: () => void;
};

const LEGACY_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";

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
    LEGACY_DEFAULT_REDIRECT_URL
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

export function bindMcpOAuthLeaseAssertion(
  lease: OpenClawStateLeaseContext | undefined,
  assertCurrent?: () => void,
): ((database: DatabaseSync) => void) | undefined {
  return lease || assertCurrent
    ? (database) => {
        assertCurrent?.();
        lease?.assertOwnedInTransaction(database);
      }
    : undefined;
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
  assertCurrent?: () => void,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    assertCurrent?.();
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    const response = await baseFetch(url, { ...init, signal });
    assertCurrent?.();
    return response;
  };
}

function beginMcpOAuthAuthorization(store: McpOAuthStore): McpOAuthStore {
  const next = { ...store };
  if (next.credentialState === "uninitialized") {
    delete next.credentialState;
  }
  return next;
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export function createMcpOAuthClientProvider(params: {
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  lease?: OpenClawStateLeaseContext;
  login?: McpOAuthLoginLifecycle;
}): OAuthClientProvider {
  const config = params.config ?? {};
  const storeKey = params.identity.storeKey;
  let preparedVerifier: string | undefined;
  const assertOwnedInTransaction = bindMcpOAuthLeaseAssertion(
    params.lease,
    params.login?.assertCurrent,
  );
  const updateStore = (
    update: (store: McpOAuthStore) => McpOAuthStore,
    beforeCommit?: () => void,
  ) =>
    updateMcpOAuthStore(storeKey, update, (database) => {
      assertOwnedInTransaction?.(database);
      beforeCommit?.();
    });
  const assertAuthorizationRedirectAllowed = () => {
    params.login?.assertCurrent();
    if (params.allowAuthorizationRedirect !== true) {
      throw new Error(
        `MCP server "${params.identity.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.identity.serverName}.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, readMcpOAuthStore(storeKey));
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, readMcpOAuthStore(storeKey));
    },
    state() {
      assertAuthorizationRedirectAllowed();
      if (params.login) {
        const store = readMcpOAuthStore(storeKey);
        if (
          store.tokens?.access_token &&
          store.pendingAuthorizationChallenge?.requiresAuthorization !== true &&
          (store.tokenExpiresAt === undefined || store.tokenExpiresAt > Date.now())
        ) {
          throw new Error(
            "Existing authentication could not be refreshed. Use the CLI sign-in flow.",
          );
        }
      }
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    clientInformation() {
      return readMcpOAuthStore(storeKey).clientInformation;
    },
    saveClientInformation(clientInformation) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), clientInformation }));
    },
    tokens() {
      if (params.suppressStoredTokens) {
        return undefined;
      }
      const store = readMcpOAuthStore(storeKey);
      const discoveredAuthorizationServerUrl = store.discoveryState?.authorizationServerUrl;
      if (!store.tokens?.refresh_token || discoveredAuthorizationServerUrl === undefined) {
        return store.tokens;
      }
      return store.tokensAuthorizationServerUrl !== undefined &&
        discoveredAuthorizationServerUrl === store.tokensAuthorizationServerUrl
        ? store.tokens
        : undefined;
    },
    saveTokens(tokens) {
      updateStore((store) => {
        const next: McpOAuthStore = { ...store, tokens };
        delete next.credentialState;
        delete next.pendingAuthorizationChallenge;
        const issuedBy = store.discoveryState?.authorizationServerUrl;
        if (issuedBy === undefined) {
          delete next.tokensAuthorizationServerUrl;
        } else {
          next.tokensAuthorizationServerUrl = issuedBy;
        }
        const tokenExpiresAt = resolveTokenExpiresAt(tokens);
        if (tokenExpiresAt === undefined) {
          delete next.tokenExpiresAt;
        } else {
          next.tokenExpiresAt = tokenExpiresAt;
        }
        return next;
      }, params.login?.beforeTokensSaved);
      params.login?.onTokensSaved();
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      const state = authorizationUrl.searchParams.get("state");
      if (params.login && (!state || !preparedVerifier)) {
        throw new Error("MCP OAuth authorization preparation is incomplete.");
      }
      updateStore((store) => ({
        ...beginMcpOAuthAuthorization(store),
        ...(preparedVerifier ? { codeVerifier: preparedVerifier } : {}),
        lastAuthorizationUrl: authorizationUrl.toString(),
        redirectUrl: resolveOAuthRedirectUrl(config, store),
      }));
      preparedVerifier = undefined;
      if (state) {
        params.login?.onAuthorizationPublished(state);
      }
    },
    saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      preparedVerifier = codeVerifier;
    },
    codeVerifier() {
      const codeVerifier = preparedVerifier ?? readMcpOAuthStore(storeKey).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    invalidateCredentials(scope) {
      params.login?.assertCurrent();
      if (params.login) {
        throw new Error("Existing authentication was retained. Use the CLI sign-in flow.");
      }
      updateStore((store) => {
        const next: McpOAuthStore = { ...store };
        if (scope === "all" || scope === "client") {
          delete next.clientInformation;
        }
        if ((scope === "all" || scope === "tokens") && params.suppressStoredTokens !== true) {
          delete next.tokens;
          delete next.tokenExpiresAt;
          delete next.tokensAuthorizationServerUrl;
          next.credentialState = "cleared";
        }
        if (scope === "all" || scope === "verifier") {
          delete next.codeVerifier;
        }
        if (scope === "all" || scope === "discovery") {
          delete next.discoveryState;
        }
        return next;
      });
    },
    saveDiscoveryState(discoveryState) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), discoveryState }));
    },
    discoveryState() {
      return readMcpOAuthStore(storeKey).discoveryState;
    },
  };
}
