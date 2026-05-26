import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, overlayRuntimeExternalOAuthProfiles, shouldBootstrapFromExternalCliCredential, shouldPersistRuntimeExternalOAuthProfile, shouldReplaceStoredOAuthCredential, type RuntimeExternalOAuthProfile } from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";
export type OAuthManagerAdapter = {
    buildApiKey: (provider: string, credentials: OAuthCredential, context: {
        cfg?: OpenClawConfig;
        agentDir?: string;
    }) => Promise<string>;
    refreshCredential: (credential: OAuthCredential) => Promise<OAuthCredentials | null>;
    readBootstrapCredential: (params: {
        profileId: string;
        credential: OAuthCredential;
    }) => OAuthCredential | null;
    isRefreshTokenReusedError: (error: unknown) => boolean;
};
export type ResolvedOAuthAccess = {
    apiKey: string;
    credential: OAuthCredential;
};
export declare class OAuthManagerRefreshError extends Error {
    #private;
    readonly profileId: string;
    readonly provider: string;
    readonly code?: string;
    readonly lockPath?: string;
    constructor(params: {
        credential: OAuthCredential;
        profileId: string;
        refreshedStore: AuthProfileStore;
        cause: unknown;
    });
    getRefreshedStore(): AuthProfileStore;
    getCredential(): OAuthCredential;
    toJSON(): {
        name: string;
        message: string;
        profileId: string;
        provider: string;
    };
}
export { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, overlayRuntimeExternalOAuthProfiles, shouldBootstrapFromExternalCliCredential, shouldPersistRuntimeExternalOAuthProfile, shouldReplaceStoredOAuthCredential, };
export type { RuntimeExternalOAuthProfile };
export declare function resolveEffectiveOAuthCredential(params: {
    profileId: string;
    credential: OAuthCredential;
    readBootstrapCredential: OAuthManagerAdapter["readBootstrapCredential"];
}): OAuthCredential;
export declare function createOAuthManager(adapter: OAuthManagerAdapter): {
    resolveOAuthAccess: (params: {
        store: AuthProfileStore;
        profileId: string;
        credential: OAuthCredential;
        agentDir?: string;
        cfg?: OpenClawConfig;
    }) => Promise<ResolvedOAuthAccess | null>;
    resetRefreshQueuesForTest: () => void;
};
