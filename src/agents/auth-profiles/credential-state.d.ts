import type { AuthProfileCredential, OAuthCredential } from "./types.js";
export type AuthCredentialReasonCode = "ok" | "missing_credential" | "invalid_expires" | "expired" | "unresolved_ref";
export declare const DEFAULT_OAUTH_REFRESH_MARGIN_MS: number;
export type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";
export declare function resolveTokenExpiryState(expires: unknown, now?: number, opts?: {
    expiringWithinMs?: number;
}): TokenExpiryState;
export declare function hasUsableOAuthCredential(credential: OAuthCredential | undefined, opts?: {
    now?: number;
    refreshMarginMs?: number;
}): boolean;
export declare function evaluateStoredCredentialEligibility(params: {
    credential: AuthProfileCredential;
    now?: number;
}): {
    eligible: boolean;
    reasonCode: AuthCredentialReasonCode;
};
