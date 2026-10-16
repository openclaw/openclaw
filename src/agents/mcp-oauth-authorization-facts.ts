import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { McpOAuthStore } from "./mcp-oauth-store.types.js";

/** Refreshable expiry does not end the grant; terminal rejection and logout do. */
export function hasMcpOAuthAuthorization(store: McpOAuthStore): boolean {
  return Boolean(
    store.tokens?.access_token &&
    store.credentialState === undefined &&
    store.pendingAuthorizationChallenge?.requiresAuthorization !== true,
  );
}

/** Only non-secret authorization facts cross the native settlement channel. */
export type McpOAuthAuthorizationFact = {
  authorizationId: string | null;
  expiresAt?: number;
};

export function projectMcpOAuthAuthorization(store: McpOAuthStore): McpOAuthAuthorizationFact {
  return {
    authorizationId: hasMcpOAuthAuthorization(store) ? (store.authorizationId ?? null) : null,
    ...(!store.tokens?.refresh_token && store.tokenExpiresAt !== undefined
      ? { expiresAt: store.tokenExpiresAt }
      : {}),
  };
}

export type McpOAuthAuthorizationReceipt = {
  kind: "mcp-oauth-authorization";
  storeKey: string;
  authorization: McpOAuthAuthorizationFact;
};

export function isMcpOAuthAuthorizationReceipt(
  value: unknown,
): value is McpOAuthAuthorizationReceipt {
  if (
    !isRecord(value) ||
    value.kind !== "mcp-oauth-authorization" ||
    typeof value.storeKey !== "string" ||
    !isRecord(value.authorization)
  ) {
    return false;
  }
  const { authorizationId, expiresAt } = value.authorization;
  return (
    (authorizationId === null ||
      (typeof authorizationId === "string" && authorizationId.length > 0)) &&
    (expiresAt === undefined || (typeof expiresAt === "number" && Number.isFinite(expiresAt)))
  );
}
