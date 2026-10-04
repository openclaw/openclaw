import { isDeepStrictEqual } from "node:util";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { normalizeAuthProfileSecretRefs } from "./credential-normalize.js";
import type { createExternalAuthRuntime } from "./external-auth.js";
import {
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import {
  isInheritedMainOAuthCredentialFromStores,
  type PersistedAuthProfileStores,
} from "./ownership.js";
import { buildPersistedAuthProfileSecretsStore } from "./persisted.js";
import {
  removePersonalAuthProfileReferences,
  setRuntimeExternalCliProfileIds,
} from "./runtime-external-profile-references.js";
import { pruneAuthProfileStoreReferences } from "./runtime-snapshot-owner.js";
import { getRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import type { AuthProfileStoreOwner } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

export type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  preserveOrderProfileIds?: Iterable<string>;
  preserveStateProfileIds?: Iterable<string>;
  pruneOrderProfileIds?: Iterable<string>;
  sharedStoreWrite?: boolean;
  syncExternalCli?: boolean;
};

function shouldKeepProfileInLocalStore(params: {
  getScopedSharedAuthStore: () => AuthProfileStore | undefined;
  owner: AuthProfileStoreOwner;
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  options?: SaveAuthProfileStoreOptions;
  persistedStores: PersistedAuthProfileStores;
  externalProfiles: () => RuntimeExternalOAuthProfile[];
}): boolean {
  const { getScopedSharedAuthStore } = params;
  const inherited = getScopedSharedAuthStore()?.profiles[params.profileId];
  if (inherited && !params.persistedStores.localStore?.profiles[params.profileId]) {
    // Runtime state updates must not turn read-through credentials into local copies.
    // Compare persisted shapes so a materialized SecretRef stays inherited too.
    const secrets = buildPersistedAuthProfileSecretsStore({
      version: AUTH_STORE_VERSION,
      profiles: { [params.profileId]: params.credential },
    });
    if (isDeepStrictEqual(secrets.profiles[params.profileId], inherited)) {
      return false;
    }
  }
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (
    isInheritedMainOAuthCredentialFromStores({
      profileId: params.profileId,
      credential: params.credential,
      persistedStores: params.persistedStores,
    })
  ) {
    return false;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  if (
    params.store.runtimeExternalProfileIds?.includes(params.profileId) &&
    !params.persistedStores.localStore?.profiles[params.profileId]
  ) {
    // Runtime external profiles are normally overlays. Persist only when they
    // have explicit local state or differ from the runtime snapshot.
    const runtimeCredential = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      params.owner.databasePath,
    )?.profiles[params.profileId];
    if (!runtimeCredential || isDeepStrictEqual(runtimeCredential, params.credential)) {
      return false;
    }
  }
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles: params.externalProfiles(),
  });
}

export function buildLocalAuthProfileStoreForSave(params: {
  getScopedSharedAuthStore: () => AuthProfileStore | undefined;
  listRuntimeExternalAuthProfiles: ReturnType<
    typeof createExternalAuthRuntime
  >["listRuntimeExternalAuthProfiles"];
  owner: AuthProfileStoreOwner;
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
  persistedStores: PersistedAuthProfileStores;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(removePersonalAuthProfileReferences(params.store));
  for (const [profileId, credential] of Object.entries(localStore.profiles)) {
    localStore.profiles[profileId] = normalizeAuthProfileSecretRefs(credential);
  }
  const { listRuntimeExternalAuthProfiles } = params;
  let externalProfiles: RuntimeExternalOAuthProfile[] | undefined;
  const getExternalProfiles = (): RuntimeExternalOAuthProfile[] =>
    (externalProfiles ??= listRuntimeExternalAuthProfiles({
      store: params.store,
      agentDir: params.agentDir,
    }));
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      shouldKeepProfileInLocalStore({
        getScopedSharedAuthStore: params.getScopedSharedAuthStore,
        owner: params.owner,
        store: params.store,
        profileId,
        credential,
        options: params.options,
        persistedStores: params.persistedStores,
        externalProfiles: getExternalProfiles,
      }),
    ),
  );
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  const keptOrderProfileIds = new Set(keptProfileIds);
  for (const profileId of normalizeUniqueStringEntries(params.options?.preserveStateProfileIds)) {
    keptProfileIds.add(profileId);
    keptOrderProfileIds.add(profileId);
  }
  for (const profileIds of Object.values(params.persistedStores.localStore?.order ?? {})) {
    for (const profileId of profileIds) {
      keptOrderProfileIds.add(profileId);
    }
  }
  for (const profileId of normalizeUniqueStringEntries(params.options?.preserveOrderProfileIds)) {
    keptOrderProfileIds.add(profileId);
  }
  for (const profileId of normalizeUniqueStringEntries(params.options?.pruneOrderProfileIds)) {
    keptOrderProfileIds.delete(profileId);
  }
  for (const profileId of keptProfileIds) {
    if (isUserModelAuthProfileId(profileId)) {
      keptProfileIds.delete(profileId);
    }
  }
  for (const profileId of keptOrderProfileIds) {
    if (isUserModelAuthProfileId(profileId)) {
      keptOrderProfileIds.delete(profileId);
    }
  }
  pruneAuthProfileStoreReferences(localStore, keptProfileIds, keptOrderProfileIds);
  if (params.options?.filterExternalAuthProfiles !== false) {
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
    setRuntimeExternalCliProfileIds(localStore, []);
  }
  return localStore;
}
