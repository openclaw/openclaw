import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import { resolveSharedAuthStorePath as resolveSharedAuthPath } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { getRuntimeAuthProfileStoreSnapshotCore } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath as resolveAgentAuthPath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

type AuthProfileOwnerReadScope = {
  isEnvOnlyAuthProfileRuntime: () => boolean;
  isIsolatedAuthProfileRuntime: () => boolean;
  resolveRuntimeAuthProfileAgentDir: (agentDir?: string) => string | undefined;
  getScopedSharedAuthStore: () => AuthProfileStore | undefined;
};

/** Resolve profile facts through the live store scope without owning another scope. */
export function createAuthProfileOwnerReader({
  isEnvOnlyAuthProfileRuntime,
  isIsolatedAuthProfileRuntime,
  resolveRuntimeAuthProfileAgentDir,
  getScopedSharedAuthStore,
}: AuthProfileOwnerReadScope) {
  /** Whether an agent dir resolves to the shared main auth-profile owner. */
  function isSharedMainAuthProfileAgentDir(agentDir?: string): boolean {
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    if (!effectiveAgentDir) {
      return true;
    }
    const mainAgentDir = resolveRuntimeAuthProfileAgentDir();
    const mainPath = mainAgentDir ? resolveAgentAuthPath(mainAgentDir) : resolveSharedAuthPath();
    return resolveAgentAuthPath(effectiveAgentDir) === mainPath;
  }

  /** Find a persisted credential in the scoped store, falling back to the main store. */
  function findPersistedAuthProfileCredential(params: {
    agentDir?: string;
    profileId: string;
  }): AuthProfileStore["profiles"][string] | undefined {
    if (isEnvOnlyAuthProfileRuntime()) {
      return undefined;
    }
    if (isUserModelAuthProfileId(params.profileId)) {
      return isIsolatedAuthProfileRuntime()
        ? undefined
        : readUserModelAuthProfile(params.profileId)?.credential;
    }
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    const requestedStore = loadPersistedAuthProfileStore(agentDir);
    const requestedProfile = requestedStore?.profiles[params.profileId];
    const scopedSharedStore = getScopedSharedAuthStore();
    if (scopedSharedStore) {
      return requestedProfile ?? scopedSharedStore.profiles[params.profileId];
    }
    if (requestedProfile || !agentDir) {
      return requestedProfile;
    }

    if (isSharedMainAuthProfileAgentDir(agentDir)) {
      return requestedProfile;
    }

    return loadPersistedAuthProfileStore(resolveRuntimeAuthProfileAgentDir())?.profiles[
      params.profileId
    ];
  }

  /** Resolve selection metadata through the same shared or bounded auth-store scope. */
  function resolveAuthProfileProviderForSelection(params: {
    agentDir?: string;
    profileId: string;
  }): string | undefined {
    if (
      isEnvOnlyAuthProfileRuntime() ||
      (isUserModelAuthProfileId(params.profileId) && isIsolatedAuthProfileRuntime())
    ) {
      return undefined;
    }
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    // A captured shared view excludes non-portable profiles that ambient snapshots
    // may contain. Legacy bounded scopes still own their directory's runtime view.
    const runtimeProvider = getScopedSharedAuthStore()
      ? undefined
      : getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles[params.profileId]?.provider;
    return (
      runtimeProvider ??
      findPersistedAuthProfileCredential({ agentDir, profileId: params.profileId })?.provider
    );
  }

  /** Resolve which agent dir owns a persisted profile, accounting for inherited OAuth. */
  function resolvePersistedAuthProfileOwnerAgentDir(params: {
    agentDir?: string;
    profileId: string;
  }): string | undefined {
    if (isEnvOnlyAuthProfileRuntime() || isUserModelAuthProfileId(params.profileId)) {
      return undefined;
    }
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    if (!agentDir) {
      return undefined;
    }
    const requestedStore = loadPersistedAuthProfileStore(agentDir);
    if (isSharedMainAuthProfileAgentDir(agentDir)) {
      return undefined;
    }

    const mainAgentDir = resolveRuntimeAuthProfileAgentDir();
    const mainStore = loadPersistedAuthProfileStore(mainAgentDir);
    const requestedProfile = requestedStore?.profiles[params.profileId];
    if (requestedProfile) {
      return shouldUseMainOwnerForLocalOAuthCredential({
        profileId: params.profileId,
        local: requestedProfile,
        main: mainStore?.profiles[params.profileId],
      })
        ? undefined
        : agentDir;
    }

    return mainStore?.profiles[params.profileId] ? undefined : agentDir;
  }

  return {
    isSharedMainAuthProfileAgentDir,
    findPersistedAuthProfileCredential,
    resolveAuthProfileProviderForSelection,
    resolvePersistedAuthProfileOwnerAgentDir,
  };
}
