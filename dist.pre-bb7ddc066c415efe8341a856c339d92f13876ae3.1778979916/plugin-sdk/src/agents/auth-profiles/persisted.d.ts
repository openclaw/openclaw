import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";
export type LegacyAuthStore = Record<string, AuthProfileCredential>;
type LoadPersistedAuthProfileStoreOptions = {
    rewriteInlineOAuthSecrets?: boolean;
    repairOAuthSecretPayloads?: boolean;
};
type OAuthProfileSecretKeySeedOptions = {
    create?: boolean;
};
type OAuthProfileSecretKeySeedDeps = {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    readMacKeychain: () => string | undefined;
    readFile: () => string | undefined;
    createFile: () => string | undefined;
};
declare function shouldReadMacKeychainForOAuthProfileSecrets(params?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): boolean;
declare function resolveOAuthProfileSecretKeySeedWithDeps(options: OAuthProfileSecretKeySeedOptions | undefined, deps: OAuthProfileSecretKeySeedDeps): string | undefined;
export declare const __testing: {
    resolveOAuthProfileSecretKeySeedWithDeps: typeof resolveOAuthProfileSecretKeySeedWithDeps;
    shouldReadMacKeychainForOAuthProfileSecrets: typeof shouldReadMacKeychainForOAuthProfileSecrets;
};
export declare function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null;
export declare function mergeAuthProfileStores(base: AuthProfileStore, override: AuthProfileStore): AuthProfileStore;
export declare function buildPersistedAuthProfileSecretsStore(store: AuthProfileStore, shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
}) => boolean, options?: {
    agentDir?: string;
}): AuthProfileSecretsStore;
export declare function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void;
export declare function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean;
export declare function removeDetachedOAuthProfileSecrets(params: {
    previousRaw: unknown;
    nextStore: AuthProfileSecretsStore;
}): void;
export declare function loadPersistedAuthProfileStore(agentDir?: string, options?: LoadPersistedAuthProfileStoreOptions): AuthProfileStore | null;
export declare function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null;
export {};
