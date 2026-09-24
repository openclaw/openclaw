/**
 * OAuth identity comparison and mirroring decisions.
 * Guards cross-agent credential copy/adoption so refreshed credentials cannot
 * overwrite a different account's local auth state.
 */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

/** Normalize account-id style identity tokens for exact comparison. */
export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalize email identity tokens for case-insensitive comparison. */
export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

export type OAuthIdentity = Pick<OAuthCredential, "accountId" | "email" | "issuer" | "clientId">;

export function hasOidcRegistration(credential: OAuthIdentity): boolean {
  return credential.issuer !== undefined && credential.clientId !== undefined;
}

/** Identity evidence includes OIDC registration, even when its subject is unavailable. */
export function hasOAuthIdentity(credential: OAuthIdentity): boolean {
  return (
    hasOidcRegistration(credential) ||
    normalizeAuthIdentityToken(credential.accountId) !== undefined ||
    normalizeAuthEmailToken(credential.email) !== undefined
  );
}

/**
 * One-sided copy gate for both directions:
 * - mirror: sub-agent refresh -> main-agent store
 * - adopt: main-agent store -> sub-agent store
 */
export function isSafeToCopyOAuthIdentity(
  existing: OAuthIdentity,
  incoming: OAuthIdentity,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  if (hasOidcRegistration(existing) || hasOidcRegistration(incoming)) {
    // The provider binds accountId to its verified registration identity before
    // persistence. Older unbound credentials must reconnect, never fall back to email.
    return (
      existing.issuer === incoming.issuer &&
      existing.clientId === incoming.clientId &&
      aAcct !== undefined &&
      aAcct === bAcct
    );
  }
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);

  if (aAcct !== undefined && bAcct !== undefined) {
    return aAcct === bAcct;
  }
  if (aEmail !== undefined && bEmail !== undefined) {
    return aEmail === bEmail;
  }

  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
  if (aHasIdentity) {
    return false;
  }

  return true;
}

type OAuthMirrorDecisionReason =
  | "no-existing-credential"
  | "incoming-fresher"
  | "non-oauth-existing-credential"
  | "provider-mismatch"
  | "identity-mismatch-or-regression"
  | "incoming-not-fresher";

type OAuthMirrorDecision =
  | {
      shouldMirror: true;
      reason: Extract<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    }
  | {
      shouldMirror: false;
      reason: Exclude<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    };

/** Decide whether a refreshed OAuth credential should mirror into another store. */
export function shouldMirrorRefreshedOAuthCredential(params: {
  existing: AuthProfileCredential | undefined;
  refreshed: OAuthCredential;
}): OAuthMirrorDecision {
  const { existing, refreshed } = params;
  if (!existing) {
    return { shouldMirror: true, reason: "no-existing-credential" };
  }
  if (existing.type !== "oauth") {
    return { shouldMirror: false, reason: "non-oauth-existing-credential" };
  }
  if (existing.provider !== refreshed.provider) {
    return { shouldMirror: false, reason: "provider-mismatch" };
  }
  if (!isSafeToCopyOAuthIdentity(existing, refreshed)) {
    return { shouldMirror: false, reason: "identity-mismatch-or-regression" };
  }
  const refreshedExpires = asDateTimestampMs(refreshed.expires);
  if (refreshedExpires === undefined) {
    return { shouldMirror: false, reason: "incoming-not-fresher" };
  }
  const existingExpires = asDateTimestampMs(existing.expires);
  if (existingExpires !== undefined && existingExpires >= refreshedExpires) {
    return { shouldMirror: false, reason: "incoming-not-fresher" };
  }
  return { shouldMirror: true, reason: "incoming-fresher" };
}
