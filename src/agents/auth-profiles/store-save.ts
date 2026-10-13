import { isDeepStrictEqual } from "node:util";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
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
import { removePersonalAuthProfileReferences } from "./runtime-external-profile-references.js";
import { pruneAuthProfileStoreReferences } from "./runtime-snapshot-owner.js";
import { getRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import type {
  AuthProfileStore,
  AuthProfileStoreOwner,
  AuthProfileStoreUpdater,
  SaveAuthProfileStoreOptions,
} from "./types.js";

export type { SaveAuthProfileStoreOptions } from "./types.js";

function validateAuthProfileStoreSecrets(store: AuthProfileStore): void {
  for (const credential of Object.values(store.profiles)) {
    normalizeAuthProfileSecretRefs(credential);
  }
}

export function prepareLegacyAuthProfileSave(store: AuthProfileStore): void {
  warnPluginSdkDeprecation({
    family: "auth-profiles",
    method: "saveAuthProfileStore",
    replacement:
      "saveAuthProfileStoreAsync for replacement or updateAuthProfileStoreWithLock from openclaw/plugin-sdk/provider-auth for partial updates",
  });
  validateAuthProfileStoreSecrets(store);
}

/** Replace the selected owner's store through its existing update and publication owner. */
export function createAuthProfileStoreSaver(update: AuthProfileStoreUpdater) {
  return async function saveAuthProfileStoreAsync(
    store: AuthProfileStore,
    agentDir?: string,
    options?: SaveAuthProfileStoreOptions,
  ): Promise<void> {
    validateAuthProfileStoreSecrets(store);
    const replacement = cloneAuthProfileStore(store);
    const updated = await update({
      agentDir,
      sharedStoreWrite: options?.sharedStoreWrite,
      saveOptions: options,
      updater(current) {
        // A whole-store save must clear omitted state and runtime metadata too.
        for (const key of Object.keys(current)) {
          Reflect.deleteProperty(current, key);
        }
        Object.assign(current, replacement);
        return true;
      },
    });
    if (!updated) {
      throw new Error("Failed to save auth profile store; retry when its writer is available.");
    }
  };
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
  runtimeStore?: AuthProfileStore;
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
    Object.entries(localStore.profiles).filter(([profileId, credential]) => {
      const inherited = params.getScopedSharedAuthStore()?.profiles[profileId];
      if (inherited && !params.persistedStores.localStore?.profiles[profileId]) {
        // Runtime state updates must not turn read-through credentials into local copies.
        // Compare persisted shapes so a materialized SecretRef stays inherited too.
        const secrets = buildPersistedAuthProfileSecretsStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: credential },
        });
        if (isDeepStrictEqual(secrets.profiles[profileId], inherited)) {
          return false;
        }
      }
      if (credential.type !== "oauth") {
        return true;
      }
      if (
        isInheritedMainOAuthCredentialFromStores({
          profileId,
          credential,
          persistedStores: params.persistedStores,
        })
      ) {
        return false;
      }
      if (params.options?.filterExternalAuthProfiles === false) {
        return true;
      }
      if (
        params.store.runtimeExternalProfileIds?.includes(profileId) &&
        !params.persistedStores.localStore?.profiles[profileId]
      ) {
        // Runtime external profiles are normally overlays. Persist only when they
        // have explicit local state or differ from the runtime snapshot.
        const runtimeCredential = (
          params.runtimeStore ??
          getRuntimeAuthProfileStoreSnapshotAtDatabasePath(params.owner.databasePath)
        )?.profiles[profileId];
        if (!runtimeCredential || isDeepStrictEqual(runtimeCredential, credential)) {
          return false;
        }
      }
      return shouldPersistRuntimeExternalOAuthProfile({
        profileId,
        credential,
        profiles: getExternalProfiles(),
      });
    }),
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
  for (const profileIds of [keptProfileIds, keptOrderProfileIds]) {
    for (const profileId of profileIds) {
      if (isUserModelAuthProfileId(profileId)) {
        profileIds.delete(profileId);
      }
    }
  }
  pruneAuthProfileStoreReferences(localStore, keptProfileIds, keptOrderProfileIds);
  if (params.options?.filterExternalAuthProfiles !== false) {
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
  }
  return localStore;
}
