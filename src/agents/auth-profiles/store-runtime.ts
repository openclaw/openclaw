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
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  ensureAuthProfileStoreForLocalUpdate,
  ensureAuthProfileStoreForLocalUpdateAsync,
  saveAuthProfileStore,
  saveAuthProfileStoreWithPreparedOwner,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = nativePluginBindings.authStore;
