// Native projection; unbound scope and snapshot operations stay in store.ts.
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
export const {
  createAuthProfileStoreReadScope,
  createAuthProfileStoreReadScopeAsync,
  updateAuthProfileStoreWithLock,
  loadAuthProfileStore,
  loadAuthProfileStoreForRuntimeAsync,
  prepareAuthProfileProvider,
  findPersistedAuthProfileCredentialAsync,
  prepareAuthProfileCredentialRead,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
  loadAuthProfileStoreForSecretsRuntimeAsync,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreForLocalUpdateAsync,
  saveAuthProfileStoreWithPreparedOwner,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = nativePluginBindings.authStore;

/**
 * @deprecated Await loadAuthProfileStoreForRuntimeAsync from openclaw/plugin-sdk/agent-runtime
 * with readOnly: true and allowKeychainPrompt: false. Retained until removal in a later stable
 * release after deprecation ships.
 */
export const loadAuthProfileStoreForSecretsRuntime =
  nativePluginBindings.authStore.loadAuthProfileStoreForSecretsRuntime;

/**
 * @deprecated Use updateAuthProfileStoreWithLock from openclaw/plugin-sdk/provider-auth.
 * Retained until removal in a later stable release after deprecation ships.
 */
export const saveAuthProfileStore = nativePluginBindings.authStore.saveAuthProfileStore;

/** @deprecated Use loadAuthProfileStoreForRuntimeAsync. Removed after stable deprecation and a compatibility period. */
export const loadAuthProfileStoreForRuntime =
  nativePluginBindings.authStore.loadAuthProfileStoreForRuntime;

/** @deprecated Use loadAuthProfileStoreWithoutExternalProfilesAsync. Removed after stable deprecation and a compatibility period. */
export const loadAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.loadAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreAsync. Removed after stable deprecation and a compatibility period. */
export const ensureAuthProfileStore = nativePluginBindings.authStore.ensureAuthProfileStore;
/** @deprecated Use ensureAuthProfileStoreWithoutExternalProfilesAsync. Removed after stable deprecation and a compatibility period. */
export const ensureAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.ensureAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreForLocalUpdateAsync. Removed after stable deprecation and a compatibility period. */
export const ensureAuthProfileStoreForLocalUpdate =
  nativePluginBindings.authStore.ensureAuthProfileStoreForLocalUpdate;
