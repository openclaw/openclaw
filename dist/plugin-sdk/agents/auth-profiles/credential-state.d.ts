import type { AuthProfileCredential } from "./types.js";
export type AuthCredentialReasonCode = "ok" | "missing_credential" | "invalid_expires" | "expired" | "unresolved_ref";
export type TokenExpiryState = "missing" | "valid" | "expired" | "invalid_expires";
export declare function resolveTokenExpiryState(expires: unknown, now?: number): TokenExpiryState;
export declare function evaluateStoredCredentialEligibility(params: {
    credential: AuthProfileCredential;
    now?: number;
}): {
    eligible: boolean;
    reasonCode: AuthCredentialReasonCode;
};
