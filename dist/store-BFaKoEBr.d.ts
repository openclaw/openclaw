import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";

//#region src/agents/auth-profiles/external-cli-discovery.d.ts
type ExternalCliAuthDiscovery = {
  mode: "none";
  allowKeychainPrompt?: false;
  config?: OpenClawConfig;
} | {
  mode: "existing";
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
} | {
  mode: "scoped";
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};
//#endregion
//#region src/agents/auth-profiles/store.d.ts
type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};
type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
};
declare function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null>;
declare function loadAuthProfileStore(): AuthProfileStore;
declare function loadAuthProfileStoreForRuntime(agentDir?: string, options?: LoadAuthProfileStoreOptions): AuthProfileStore;
declare function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore;
declare function loadAuthProfileStoreWithoutExternalProfiles(agentDir?: string, loadOptions?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "resolveLegacyOAuthSidecars">): AuthProfileStore;
declare function ensureAuthProfileStore(agentDir?: string, options?: {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCli?: ExternalCliAuthDiscovery;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
}): AuthProfileStore;
declare function ensureAuthProfileStoreWithoutExternalProfiles(agentDir?: string, options?: {
  allowKeychainPrompt?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
}): AuthProfileStore;
declare function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined;
declare function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined;
declare function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore;
declare function replaceRuntimeAuthProfileStoreSnapshots(entries: Array<{
  agentDir?: string;
  store: AuthProfileStore;
}>): void;
declare function clearRuntimeAuthProfileStoreSnapshots(): void;
declare function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string, options?: SaveAuthProfileStoreOptions): void;
//#endregion
export { findPersistedAuthProfileCredential as a, loadAuthProfileStoreForSecretsRuntime as c, resolvePersistedAuthProfileOwnerAgentDir as d, saveAuthProfileStore as f, ensureAuthProfileStoreWithoutExternalProfiles as i, loadAuthProfileStoreWithoutExternalProfiles as l, ExternalCliAuthDiscovery as m, ensureAuthProfileStore as n, loadAuthProfileStore as o, updateAuthProfileStoreWithLock as p, ensureAuthProfileStoreForLocalUpdate as r, loadAuthProfileStoreForRuntime as s, clearRuntimeAuthProfileStoreSnapshots as t, replaceRuntimeAuthProfileStoreSnapshots as u };