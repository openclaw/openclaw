import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { McpOAuthMutation, McpOAuthStore } from "./mcp-oauth-store.types.js";

export const MCP_OAUTH_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";

function beginMcpOAuthAuthorization(store: McpOAuthStore): McpOAuthStore {
  const next = { ...store };
  if (next.credentialState === "uninitialized") {
    delete next.credentialState;
  }
  return next;
}

function bindMcpOAuthTokensIssuer(store: McpOAuthStore): McpOAuthStore {
  const issuedBy = store.discoveryState?.authorizationServerUrl;
  if (
    !store.tokens?.refresh_token ||
    store.tokensAuthorizationServerUrl !== undefined ||
    issuedBy === undefined
  ) {
    return store;
  }
  return { ...store, tokensAuthorizationServerUrl: issuedBy };
}

function applyMcpOAuthAuthorizationChallenge(
  current: McpOAuthStore,
  params: {
    resourceMetadataUrl?: string;
    scope?: string;
    requiresAuthorization?: true;
  },
): McpOAuthStore {
  const next: McpOAuthStore = {
    ...current,
    pendingAuthorizationChallenge: {
      ...current.pendingAuthorizationChallenge,
      ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.requiresAuthorization ? { requiresAuthorization: true } : {}),
    },
  };
  if (
    current.credentialState === undefined &&
    current.tokens === undefined &&
    current.clientInformation === undefined &&
    current.codeVerifier === undefined &&
    current.discoveryState === undefined &&
    current.lastAuthorizationUrl === undefined &&
    current.redirectUrl === undefined
  ) {
    next.credentialState = "uninitialized";
  }
  if (
    params.resourceMetadataUrl &&
    current.discoveryState?.resourceMetadataUrl !== params.resourceMetadataUrl
  ) {
    const bound = bindMcpOAuthTokensIssuer(next);
    delete bound.discoveryState;
    return bound;
  }
  return next;
}

/** Apply an SDK or flow operation to the authoritative transaction snapshot. */
export function applyMcpOAuthMutation(
  store: McpOAuthStore,
  mutation: McpOAuthMutation,
): { store: McpOAuthStore; applied: boolean } {
  switch (mutation.kind) {
    case "clientInformation":
      return {
        store: {
          ...beginMcpOAuthAuthorization(store),
          clientInformation: mutation.clientInformation,
        },
        applied: true,
      };
    case "codeVerifier":
      return {
        store: { ...beginMcpOAuthAuthorization(store), codeVerifier: mutation.codeVerifier },
        applied: true,
      };
    case "discoveryState":
      return {
        store: { ...beginMcpOAuthAuthorization(store), discoveryState: mutation.discoveryState },
        applied: true,
      };
    case "authorizationRedirect":
      return {
        store: {
          ...beginMcpOAuthAuthorization(store),
          lastAuthorizationUrl: mutation.authorizationUrl,
          redirectUrl:
            mutation.redirectUrl ??
            normalizeOptionalString(store.redirectUrl) ??
            MCP_OAUTH_DEFAULT_REDIRECT_URL,
        },
        applied: true,
      };
    case "bindTokensIssuer":
      return { store: bindMcpOAuthTokensIssuer(store), applied: true };
    case "authorizationChallenge":
      return mutation.rejectedAccessToken !== undefined &&
        store.tokens?.access_token !== mutation.rejectedAccessToken
        ? { store, applied: false }
        : { store: applyMcpOAuthAuthorizationChallenge(store, mutation), applied: true };
    case "completeAuthorization": {
      const next = { ...store };
      delete next.codeVerifier;
      delete next.lastAuthorizationUrl;
      delete next.redirectUrl;
      return { store: next, applied: true };
    }
    case "tokens": {
      const tokens = mutation.tokens;
      const next: McpOAuthStore = { ...store, tokens };
      delete next.credentialState;
      delete next.pendingAuthorizationChallenge;
      const issuedBy = store.discoveryState?.authorizationServerUrl;
      if (issuedBy === undefined) {
        delete next.tokensAuthorizationServerUrl;
      } else {
        next.tokensAuthorizationServerUrl = issuedBy;
      }
      const tokenExpiresAt = mutation.tokenExpiresAt;
      if (tokenExpiresAt === undefined) {
        delete next.tokenExpiresAt;
      } else {
        next.tokenExpiresAt = tokenExpiresAt;
      }
      return { store: next, applied: true };
    }
    case "invalidate": {
      const { scope, suppressStoredTokens } = mutation;
      const next = { ...store };
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
      }
      if ((scope === "all" || scope === "tokens") && !suppressStoredTokens) {
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
      return { store: next, applied: true };
    }
  }
  void (mutation satisfies never);
  throw new Error("Unknown MCP OAuth mutation");
}
