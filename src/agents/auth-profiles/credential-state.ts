import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { parseSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import { isOAuthRefreshFence } from "./oauth-refresh-marker.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

export type AuthCredentialReasonCode =
  | "ok"
  | "setup_inactive"
  | "missing_credential"
  | "invalid_expires"
  | "expired"
  | "unresolved_ref"
  | "malformed_api_key";

export const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";

export function resolveTokenExpiryState(
  expires: unknown,
  now = Date.now(),
  opts?: {
    expiringWithinMs?: number;
  },
): TokenExpiryState {
  if (expires === undefined) {
    return "missing";
  }
  if (typeof expires !== "number") {
    return "invalid_expires";
  }
  if (!Number.isFinite(expires) || expires <= 0 || expires > MAX_DATE_TIMESTAMP_MS) {
    return "invalid_expires";
  }
  const remainingMs = expires - now;
  if (remainingMs <= 0) {
    return "expired";
  }
  const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? 0);
  if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) {
    return "expiring";
  }
  return "valid";
}

export function hasUsableOAuthCredential(
  credential: OAuthCredential | undefined,
  opts?: {
    now?: number;
    refreshMarginMs?: number;
  },
): boolean {
  if (!credential || credential.type !== "oauth" || isOAuthRefreshFence(credential)) {
    return false;
  }
  if (typeof credential.access !== "string" || credential.access.trim().length === 0) {
    return false;
  }
  const now = opts?.now ?? Date.now();
  const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? DEFAULT_OAUTH_REFRESH_MARGIN_MS);
  return (
    resolveTokenExpiryState(credential.expires, now, {
      expiringWithinMs: refreshMarginMs,
    }) === "valid"
  );
}

export function isMalformedApiKeyInput(value: unknown): boolean {
  const normalized = normalizeSecretInputString(value);
  return (
    normalized !== undefined &&
    /^openclaw\s+onboard(?:\s+.*)?\s+--auth-choice(?:\s|=|$)/i.test(normalized)
  );
}

export function evaluateStoredCredentialEligibility(params: {
  credential: AuthProfileCredential;
  now?: number;
}): { eligible: boolean; reasonCode: AuthCredentialReasonCode } {
  const now = params.now ?? Date.now();
  const credential = params.credential;

  // SecretRef and literal secret strings are both configured credentials;
  // unresolved refs are classified separately for callers to surface useful copy.
  if (credential.type === "api_key") {
    const hasKey = normalizeSecretInputString(credential.key) !== undefined;
    const hasKeyRef = parseSecretRef(credential.keyRef) !== null;
    if (isMalformedApiKeyInput(credential.key)) {
      return { eligible: false, reasonCode: "malformed_api_key" };
    }
    if (!hasKey && !hasKeyRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  if (credential.type === "token") {
    const hasToken = normalizeSecretInputString(credential.token) !== undefined;
    const hasTokenRef = parseSecretRef(credential.tokenRef) !== null;
    if (!hasToken && !hasTokenRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }

    const expiryState = resolveTokenExpiryState(credential.expires, now);
    if (expiryState === "invalid_expires") {
      return { eligible: false, reasonCode: "invalid_expires" };
    }
    if (expiryState === "expired") {
      return { eligible: false, reasonCode: "expired" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  if (isOAuthRefreshFence(credential)) {
    return { eligible: false, reasonCode: "expired" };
  }
  if (
    normalizeSecretInputString(credential.access) === undefined &&
    normalizeSecretInputString(credential.refresh) === undefined
  ) {
    if (credential.oauthRef) {
      return { eligible: false, reasonCode: "unresolved_ref" };
    }
    return { eligible: false, reasonCode: "missing_credential" };
  }
  return { eligible: true, reasonCode: "ok" };
}
