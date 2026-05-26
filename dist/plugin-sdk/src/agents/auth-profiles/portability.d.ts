import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";
export type AuthProfilePortabilityReason = "portable-static-credential" | "non-portable-oauth-refresh-token" | "credential-opted-out" | "oauth-provider-opted-in";
export type AuthProfilePortability = {
    portable: boolean;
    reason: AuthProfilePortabilityReason;
};
export declare function resolveAuthProfilePortability(credential: AuthProfileCredential): AuthProfilePortability;
export declare function isAuthProfileCredentialPortableForAgentCopy(credential: AuthProfileCredential): boolean;
export declare function buildPortableAuthProfileSecretsStoreForAgentCopy(store: AuthProfileStore): {
    store: AuthProfileSecretsStore;
    copiedProfileIds: string[];
    skippedProfileIds: string[];
};
