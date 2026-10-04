/**
 * Auth-profile source probes for runtime and persisted stores.
 * These checks intentionally avoid loading secret-bearing credential payloads.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { evaluateStoredCredentialEligibility } from "./credential-state.js";
import { hasLegacyAuthProfileCredentialSource } from "./legacy-source-diagnostic.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { coercePersistedAuthProfileStore } from "./persisted.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
  hasAnyRuntimeAuthProfileStoreSource,
  hasRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

function storeHasProviderProfile(
  store: AuthProfileStore | null,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const profiles = store?.profiles;
  if (!profiles) {
    return false;
  }
  const expected = normalizeLowercaseStringOrEmpty(provider);
  const credentials =
    profileIds?.map((profileId) => profiles[profileId]) ?? Object.values(profiles);
  return credentials.some(
    (credential) =>
      credential !== undefined &&
      normalizeLowercaseStringOrEmpty(credential.provider) === expected &&
      evaluateStoredCredentialEligibility({ credential }).eligible,
  );
}

function canonicalStoreOwnsProviderRoute(
  agentDir: string | undefined,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  if (inspection.status === "missing") {
    return false;
  }
  const store =
    inspection.status === "readable" ? coercePersistedAuthProfileStore(inspection.raw) : null;
  if (!store) {
    // A present but unreadable canonical row must route through the loader so
    // AUTH_PROFILE_STORE_UNREADABLE fails closed before env/config fallback.
    return true;
  }
  return storeHasProviderProfile(store, provider, profileIds);
}

/** Returns true when any local/runtime/main auth profile source exists. */
export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasLocalAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }

  const authPath = agentDir
    ? resolveAuthProfileDatabasePath(agentDir)
    : resolveSharedAuthStorePath();
  const mainAuthPath = resolveSharedAuthStorePath();
  if (
    agentDir &&
    authPath !== mainAuthPath &&
    (hasLegacyAuthProfileCredentialSource(undefined) ||
      inspectPersistedAuthProfileStoreRaw(undefined).status !== "missing" ||
      readPersistedAuthProfileStateRaw(undefined))
  ) {
    return true;
  }
  return false;
}

/** Returns true when the requested agent dir has a local auth profile source. */
export function hasLocalAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasLegacyAuthProfileCredentialSource(agentDir)) {
    return true;
  }
  if (inspectPersistedAuthProfileStoreRaw(agentDir).status !== "missing") {
    return true;
  }
  return Boolean(readPersistedAuthProfileStateRaw(agentDir));
}

type AuthProfileSourceForProviderOptions = {
  /** Optional hard order/profile constraint from config auth.order. */
  profileIds?: readonly string[];
};

/** Returns true when a read-only auth-profile source contains a profile for a provider. */
export function hasAuthProfileStoreSourceForProvider(
  provider: string,
  agentDir?: string,
  options?: AuthProfileSourceForProviderOptions,
): boolean {
  if (!normalizeLowercaseStringOrEmpty(provider)) {
    return false;
  }
  const profileIds = options?.profileIds;
  if (profileIds?.length === 0) {
    return false;
  }
  const localRuntimeStore = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
  if (
    storeHasProviderProfile(
      coercePersistedAuthProfileStore(localRuntimeStore),
      provider,
      profileIds,
    )
  ) {
    return true;
  }
  // A retired credential source is intentionally opaque to runtime. Treat it
  // as potentially owning the provider so the canonical loader can fail closed
  // with AUTH_PROFILE_MIGRATION_REQUIRED instead of falling through to env auth.
  if (hasLegacyAuthProfileCredentialSource(agentDir)) {
    return true;
  }
  if (canonicalStoreOwnsProviderRoute(agentDir, provider, profileIds)) {
    return true;
  }

  if (!agentDir) {
    return false;
  }
  const mainRuntimeStore = getRuntimeAuthProfileStoreSnapshotCore();
  if (
    storeHasProviderProfile(coercePersistedAuthProfileStore(mainRuntimeStore), provider, profileIds)
  ) {
    return true;
  }
  if (hasLegacyAuthProfileCredentialSource()) {
    return true;
  }
  return canonicalStoreOwnsProviderRoute(undefined, provider, profileIds);
}
