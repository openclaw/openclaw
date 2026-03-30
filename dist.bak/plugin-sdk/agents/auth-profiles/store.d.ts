import type { AuthProfileStore } from "./types.js";
type LoadAuthProfileStoreOptions = {
    allowKeychainPrompt?: boolean;
    readOnly?: boolean;
};
export declare function replaceRuntimeAuthProfileStoreSnapshots(entries: Array<{
    agentDir?: string;
    store: AuthProfileStore;
}>): void;
export declare function clearRuntimeAuthProfileStoreSnapshots(): void;
export declare function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null>;
export declare function loadAuthProfileStore(): AuthProfileStore;
export declare function loadAuthProfileStoreForRuntime(agentDir?: string, options?: LoadAuthProfileStoreOptions): AuthProfileStore;
export declare function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore;
export declare function ensureAuthProfileStore(agentDir?: string, options?: {
    allowKeychainPrompt?: boolean;
}): AuthProfileStore;
export declare function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void;
export {};
