import type { AuthProfileStore, OAuthCredential } from "./types.js";
export type RuntimeExternalOAuthProfile = {
    profileId: string;
    credential: OAuthCredential;
    persistence?: "runtime-only" | "persisted";
};
export declare function areOAuthCredentialsEquivalent(a: OAuthCredential | undefined, b: OAuthCredential): boolean;
export declare function shouldReplaceStoredOAuthCredential(existing: OAuthCredential | undefined, incoming: OAuthCredential): boolean;
export declare function hasUsableOAuthCredential(credential: OAuthCredential | undefined, now?: number): boolean;
export declare function normalizeAuthIdentityToken(value: string | undefined): string | undefined;
export declare function normalizeAuthEmailToken(value: string | undefined): string | undefined;
export declare function hasOAuthIdentity(credential: Pick<OAuthCredential, "accountId" | "email">): boolean;
export declare function isSafeToOverwriteStoredOAuthIdentity(existing: OAuthCredential | undefined, incoming: OAuthCredential): boolean;
export declare function isSafeToAdoptBootstrapOAuthIdentity(existing: OAuthCredential | undefined, incoming: OAuthCredential): boolean;
export declare function isSafeToAdoptMainStoreOAuthIdentity(existing: OAuthCredential | undefined, incoming: OAuthCredential): boolean;
export declare function shouldBootstrapFromExternalCliCredential(params: {
    existing: OAuthCredential | undefined;
    imported: OAuthCredential;
    now?: number;
}): boolean;
export declare function overlayRuntimeExternalOAuthProfiles(store: AuthProfileStore, profiles: Iterable<RuntimeExternalOAuthProfile>): AuthProfileStore;
export declare function shouldPersistRuntimeExternalOAuthProfile(params: {
    profileId: string;
    credential: OAuthCredential;
    profiles: Iterable<RuntimeExternalOAuthProfile>;
}): boolean;
