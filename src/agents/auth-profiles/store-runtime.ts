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
  loadAuthProfileStoreForCatalogAsync,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreForLocalUpdateAsync,
  saveAuthProfileStoreWithPreparedOwner,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = nativePluginBindings.authStore;

/**
 * @deprecated Await loadAuthProfileStoreForRuntimeAsync from openclaw/plugin-sdk/agent-runtime
 * with readOnly: true and allowKeychainPrompt: false. Supported through 2026-12-31.
 */
export const loadAuthProfileStoreForSecretsRuntime =
  nativePluginBindings.authStore.loadAuthProfileStoreForSecretsRuntime;

/**
 * @deprecated Use updateAuthProfileStoreWithLock from openclaw/plugin-sdk/provider-auth.
 * Supported through 2026-12-31.
 */
export const saveAuthProfileStore = nativePluginBindings.authStore.saveAuthProfileStore;

/** @deprecated Use loadAuthProfileStoreForRuntimeAsync. Supported through 2026-12-31. */
export const loadAuthProfileStoreForRuntime =
  nativePluginBindings.authStore.loadAuthProfileStoreForRuntime;

/** @deprecated Use loadAuthProfileStoreWithoutExternalProfilesAsync. Supported through 2026-12-31. */
export const loadAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.loadAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreAsync. Supported through 2026-12-31. */
export const ensureAuthProfileStore = nativePluginBindings.authStore.ensureAuthProfileStore;
/** @deprecated Use ensureAuthProfileStoreWithoutExternalProfilesAsync. Supported through 2026-12-31. */
export const ensureAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.ensureAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreForLocalUpdateAsync. Supported through 2026-12-31. */
export const ensureAuthProfileStoreForLocalUpdate =
  nativePluginBindings.authStore.ensureAuthProfileStoreForLocalUpdate;
