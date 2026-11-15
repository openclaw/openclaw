import type { McpOAuthStore } from "./mcp-oauth-store.types.js";

/** Persisted OAuth authorization state for one principal and MCP server. */
export type McpOAuthPrincipalStatus =
  | { state: "authorized"; expiresAt?: number }
  | { state: "requires-authorization" }
  | { state: "pending-authorization" }
  | { state: "unauthenticated" };

export function projectMcpOAuthCredentialsStatus(store: McpOAuthStore): McpOAuthPrincipalStatus {
  // A refresh claim also exists briefly during a live exchange; a fenced one persists
  // and blocks every token use until a new sign-in replaces the grant.
  if (
    store.pendingAuthorizationChallenge?.requiresAuthorization === true ||
    store.refreshClaim !== undefined
  ) {
    return { state: "requires-authorization" };
  }
  if (store.tokens) {
    return {
      state: "authorized",
      ...(store.tokenExpiresAt === undefined ? {} : { expiresAt: store.tokenExpiresAt }),
    };
  }
  if (
    store.clientInformation ||
    store.codeVerifier ||
    store.discoveryState ||
    store.lastAuthorizationUrl ||
    store.redirectUrl ||
    store.pendingAuthorizationChallenge
  ) {
    return { state: "pending-authorization" };
  }
  return { state: "unauthenticated" };
}
