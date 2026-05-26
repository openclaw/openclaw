import type { AuthProfileStore, OAuthCredential } from "./types.js";
export { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, shouldBootstrapFromExternalCliCredential, shouldReplaceStoredOAuthCredential, } from "./oauth-shared.js";
export type ExternalCliResolvedProfile = {
    profileId: string;
    credential: OAuthCredential;
    persistence?: "runtime-only" | "persisted";
};
export type ExternalCliAuthProfileOptions = {
    allowKeychainPrompt?: boolean;
    providerIds?: Iterable<string>;
    profileIds?: Iterable<string>;
};
export declare function isSafeToUseExternalCliCredential(existing: OAuthCredential | undefined, imported: OAuthCredential): boolean;
export declare function readExternalCliBootstrapCredential(params: {
    profileId: string;
    credential: OAuthCredential;
    allowInlineOAuthTokenMaterial?: boolean;
    allowKeychainPrompt?: boolean;
}): OAuthCredential | null;
export declare const readManagedExternalCliCredential: typeof readExternalCliBootstrapCredential;
export declare function readExternalCliFallbackCredential(params: {
    profileId: string;
    credential: OAuthCredential;
    allowKeychainPrompt?: boolean;
}): OAuthCredential | null;
export declare function resolveExternalCliAuthProfiles(store: AuthProfileStore, options?: ExternalCliAuthProfileOptions): ExternalCliResolvedProfile[];
