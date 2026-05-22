import type { AuthProfileStore, OAuthCredential } from "./types.js";
export { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, shouldBootstrapFromExternalCliCredential, shouldReplaceStoredOAuthCredential, } from "./oauth-shared.js";
export type ExternalCliResolvedProfile = {
    profileId: string;
    credential: OAuthCredential;
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
}): OAuthCredential | null;
export declare const readManagedExternalCliCredential: typeof readExternalCliBootstrapCredential;
export declare function resolveExternalCliAuthProfiles(store: AuthProfileStore, options?: ExternalCliAuthProfileOptions): ExternalCliResolvedProfile[];
