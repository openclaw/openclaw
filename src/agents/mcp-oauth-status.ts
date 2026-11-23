import type { McpOAuthStore } from "./mcp-oauth-store.types.js";

/** Persisted OAuth authorization state for one principal and MCP server. */
export type McpOAuthPrincipalStatus =
  | { state: "authorized"; expiresAt?: number }
  | { state: "requires-authorization" }
  | { state: "pending-authorization" }
  | { state: "unauthenticated" };

/** One stored principal and the pre-registered client its config requires, if any. */
export type McpOAuthStatusQuery = { storeKey: string; clientId?: string };

/** Whether stored credentials belong to the configured pre-registered client, if any. */
export function isMcpOAuthStoreBoundToClient(
  store: McpOAuthStore,
  clientId: string | undefined,
): boolean {
  return clientId === undefined || store.clientInformation?.client_id === clientId;
}

/** `clientId` is the configured pre-registered client; tokens issued to another client need sign-in. */
export function projectMcpOAuthCredentialsStatus(
  store: McpOAuthStore,
  clientId?: string,
): McpOAuthPrincipalStatus {
  // A refresh claim also exists briefly during a live exchange; a fenced one persists
  // and blocks every token use until a new sign-in replaces the grant.
  if (
    store.pendingAuthorizationChallenge?.requiresAuthorization === true ||
    store.refreshClaim !== undefined ||
    (store.tokens !== undefined && !isMcpOAuthStoreBoundToClient(store, clientId))
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
