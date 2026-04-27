import type { AuthProfileCredential, OAuthCredential } from "./types.js";
export declare function normalizeAuthIdentityToken(value: string | undefined): string | undefined;
export declare function normalizeAuthEmailToken(value: string | undefined): string | undefined;
/**
 * Returns true if `existing` and `incoming` provably belong to the same
 * account. Used to gate cross-agent credential mirroring.
 */
export declare function isSameOAuthIdentity(existing: Pick<OAuthCredential, "accountId" | "email">, incoming: Pick<OAuthCredential, "accountId" | "email">): boolean;
/**
 * One-sided copy gate for both directions:
 * - mirror: sub-agent refresh -> main-agent store
 * - adopt: main-agent store -> sub-agent store
 */
export declare function isSafeToCopyOAuthIdentity(existing: Pick<OAuthCredential, "accountId" | "email">, incoming: Pick<OAuthCredential, "accountId" | "email">): boolean;
export type OAuthMirrorDecisionReason = "no-existing-credential" | "incoming-fresher" | "non-oauth-existing-credential" | "provider-mismatch" | "identity-mismatch-or-regression" | "incoming-not-fresher";
export type OAuthMirrorDecision = {
    shouldMirror: true;
    reason: Extract<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
} | {
    shouldMirror: false;
    reason: Exclude<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
};
export declare function shouldMirrorRefreshedOAuthCredential(params: {
    existing: AuthProfileCredential | undefined;
    refreshed: OAuthCredential;
}): OAuthMirrorDecision;
