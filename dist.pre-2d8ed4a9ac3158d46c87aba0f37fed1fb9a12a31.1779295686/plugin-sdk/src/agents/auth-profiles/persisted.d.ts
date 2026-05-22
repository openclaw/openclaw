import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";
export type LegacyAuthStore = Record<string, AuthProfileCredential>;
type LoadPersistedAuthProfileStoreOptions = {
    allowKeychainPrompt?: boolean;
    resolveLegacyOAuthSidecars?: boolean;
};
export declare function isRuntimeLegacyOAuthSidecarCredential(credential: AuthProfileCredential | undefined): boolean;
export declare function matchesRuntimeLegacyOAuthSidecarMaterial(params: {
    authPath?: string;
    profileId: string;
    credential: AuthProfileCredential | undefined;
}): boolean;
export declare function coercePersistedAuthProfileStore(raw: unknown, options?: LoadPersistedAuthProfileStoreOptions, storeKey?: string): AuthProfileStore | null;
export declare function mergeAuthProfileStores(base: AuthProfileStore, override: AuthProfileStore): AuthProfileStore;
export declare function buildPersistedAuthProfileSecretsStore(store: AuthProfileStore, shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
}) => boolean, options?: {
    existingRaw?: unknown;
    runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
}): AuthProfileSecretsStore;
export declare function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void;
export declare function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean;
export declare function loadPersistedAuthProfileStore(agentDir?: string, options?: LoadPersistedAuthProfileStoreOptions): AuthProfileStore | null;
export declare function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null;
export {};
