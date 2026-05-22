import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";
export type LegacyAuthStore = Record<string, AuthProfileCredential>;
export declare function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null;
export declare function mergeAuthProfileStores(base: AuthProfileStore, override: AuthProfileStore): AuthProfileStore;
export declare function buildPersistedAuthProfileSecretsStore(store: AuthProfileStore, shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
}) => boolean): AuthProfileSecretsStore;
export declare function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void;
export declare function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean;
export declare function loadPersistedAuthProfileStore(agentDir?: string): AuthProfileStore | null;
export declare function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null;
