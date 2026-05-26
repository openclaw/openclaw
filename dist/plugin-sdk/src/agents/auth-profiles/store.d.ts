import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import type { AuthProfileStore } from "./types.js";
type LoadAuthProfileStoreOptions = {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    readOnly?: boolean;
    syncExternalCli?: boolean;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
};
type SaveAuthProfileStoreOptions = {
    filterExternalAuthProfiles?: boolean;
    syncExternalCli?: boolean;
};
export declare function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null>;
export declare function loadAuthProfileStore(): AuthProfileStore;
export declare function loadAuthProfileStoreForRuntime(agentDir?: string, options?: LoadAuthProfileStoreOptions): AuthProfileStore;
export declare function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore;
export declare function loadAuthProfileStoreWithoutExternalProfiles(agentDir?: string): AuthProfileStore;
export declare function ensureAuthProfileStore(agentDir?: string, options?: {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
}): AuthProfileStore;
export declare function ensureAuthProfileStoreWithoutExternalProfiles(agentDir?: string, options?: {
    allowKeychainPrompt?: boolean;
}): AuthProfileStore;
export declare function findPersistedAuthProfileCredential(params: {
    agentDir?: string;
    profileId: string;
}): AuthProfileStore["profiles"][string] | undefined;
export declare function resolvePersistedAuthProfileOwnerAgentDir(params: {
    agentDir?: string;
    profileId: string;
}): string | undefined;
export declare function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore;
export { hasAnyAuthProfileStoreSource } from "./source-check.js";
export declare function replaceRuntimeAuthProfileStoreSnapshots(entries: Array<{
    agentDir?: string;
    store: AuthProfileStore;
}>): void;
export declare function clearRuntimeAuthProfileStoreSnapshots(): void;
export declare function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string, options?: SaveAuthProfileStoreOptions): void;
