import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { continueAuthProfileAuthorizationForDisplayName } from "./authorization-lifetime.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import { getScopedAuthProfileEnv } from "./runtime-scope.js";
import { isSharedAuthProfileWrite } from "./shared-store-bootstrap.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { AuthProfileCredential, RuntimeAuthProfileStore } from "./types.js";

function isExternallyOwned(profileId: string, credential: AuthProfileCredential): boolean {
  return (
    credential.type === "oauth" && isPersistedExternalCliAuthProfile({ profileId, credential })
  );
}

export function resolveAuthProfileDisplayNameTarget(params: {
  cfg: OpenClawConfig;
  store: RuntimeAuthProfileStore;
  agentDir: string;
  profileId: string;
  configBound: boolean;
}): "config" | "external" | "local" | "shared" | undefined {
  const { cfg, store, agentDir, profileId } = params;
  const credential = Object.hasOwn(store.profiles, profileId)
    ? store.profiles[profileId]
    : undefined;
  if (!credential || isUserModelAuthProfileId(profileId)) {
    return undefined;
  }
  if (params.configBound || normalizeOptionalString(cfg.auth?.profiles?.[profileId]?.displayName)) {
    return "config";
  }
  if (
    store.runtimeExternalProfileIds?.includes(profileId) ||
    isExternallyOwned(profileId, credential)
  ) {
    return "external";
  }
  if (credential.setup) {
    return undefined;
  }
  if (store.runtimeLocalProfileIds?.includes(profileId)) {
    return "local";
  }
  // The canonical main agent owns shared accounts even when their rows are in the
  // state database. An inheriting agent may not write through to that store.
  if (
    store.runtimePersistedProfileIds?.includes(profileId) &&
    isSharedAuthProfileWrite({
      agentDir,
      allowExplicitMain: true,
      env: getScopedAuthProfileEnv() ?? process.env,
    })
  ) {
    return "shared";
  }
  return undefined;
}

/** Update only the metadata on an existing credential; never enroll or copy a credential. */
export async function setAuthProfileDisplayName(params: {
  agentDir?: string;
  profileId: string;
  displayName: string | null;
  preserveStateProfileIds: Iterable<string>;
}): Promise<"saved" | "unwritable" | "unavailable"> {
  const { profileId, displayName } = params;
  if (isUserModelAuthProfileId(profileId)) {
    return "unwritable";
  }
  let writable = false;
  const store = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
      preserveStateProfileIds: params.preserveStateProfileIds,
    },
    updater(current, _owner, shared) {
      const credential = Object.hasOwn(current.profiles, profileId)
        ? current.profiles[profileId]
        : undefined;
      if (
        !credential ||
        credential.setup ||
        isExternallyOwned(profileId, credential) ||
        shouldUseMainOwnerForLocalOAuthCredential({
          profileId,
          local: credential,
          main: shared?.profiles[profileId],
        })
      ) {
        return false;
      }
      writable = true;
      if (credential.displayName === (displayName ?? undefined)) {
        return false;
      }
      const { displayName: _previous, ...grant } = credential;
      current.profiles[profileId] = continueAuthProfileAuthorizationForDisplayName(
        credential,
        displayName === null ? grant : { ...grant, displayName },
      );
      return true;
    },
  });
  return !store ? "unavailable" : writable ? "saved" : "unwritable";
}
