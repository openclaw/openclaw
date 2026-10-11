// Native projection; unbound scope and snapshot operations stay in store.ts.
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
export const {
  createAuthProfileStoreReadScope,
  updateAuthProfileStoreWithLock,
  loadAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreForRuntimeAsync,
  prepareAuthProfileProvider,
  findPersistedAuthProfileCredentialAsync,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreForLocalUpdateAsync,
  saveAuthProfileStore,
  saveAuthProfileStoreWithPreparedOwner,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = nativePluginBindings.authStore;

/** @deprecated Use loadAuthProfileStoreWithoutExternalProfilesAsync. Removed at the next Plugin SDK major. */
export const loadAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.loadAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreAsync. Removed at the next Plugin SDK major. */
export const ensureAuthProfileStore = nativePluginBindings.authStore.ensureAuthProfileStore;
/** @deprecated Use ensureAuthProfileStoreWithoutExternalProfilesAsync. Removed at the next Plugin SDK major. */
export const ensureAuthProfileStoreWithoutExternalProfiles =
  nativePluginBindings.authStore.ensureAuthProfileStoreWithoutExternalProfiles;
/** @deprecated Use ensureAuthProfileStoreForLocalUpdateAsync. Removed at the next Plugin SDK major. */
export const ensureAuthProfileStoreForLocalUpdate =
  nativePluginBindings.authStore.ensureAuthProfileStoreForLocalUpdate;
