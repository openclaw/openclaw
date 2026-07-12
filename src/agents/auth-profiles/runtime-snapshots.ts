import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import { resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileStore } from "./types.js";

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();
let runtimeAuthStoreCredentialsRevision = 0;
const persistedStoreMutationRevision = new Map<string, number>();
const persistedProfileMutationRevision = new Map<string, Map<string, number>>();

function credentialState(
  entries: Iterable<[string, AuthProfileStore]>,
): Array<readonly [string, AuthProfileStore["profiles"]]> {
  return Array.from(entries)
    .filter(([, store]) => Object.keys(store.profiles).length > 0)
    .map(([key, store]) => [key, store.profiles] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function replaceChangesCredentials(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): boolean {
  const next = new Map(
    entries.map((entry) => [resolveRuntimeStoreKey(entry.agentDir), entry.store] as const),
  );
  return !isDeepStrictEqual(credentialState(runtimeAuthStoreSnapshots), credentialState(next));
}

// Runtime snapshots are keyed by the resolved auth store path so default-agent
// and per-agent stores do not overwrite each other.
function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

/** Reads a cloned runtime auth profile store snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir));
  return store ? cloneAuthProfileStore(store) : undefined;
}

/** Lists cloned live snapshots for transactional rollback composition. */
export function listRuntimeAuthProfileStoreSnapshots(): Array<{
  agentDir: string;
  store: AuthProfileStore;
}> {
  return Array.from(runtimeAuthStoreSnapshots, ([key, store]) => ({
    agentDir: path.dirname(key),
    store: cloneAuthProfileStore(store),
  }));
}

/** Returns true when a runtime snapshot exists for an agent dir. */
export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}

/** Returns true when requested or main runtime snapshots contain profiles. */
export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (requestedStore && Object.keys(requestedStore.profiles).length > 0) {
    return true;
  }
  if (!agentDir) {
    return false;
  }
  const mainStore = getRuntimeAuthProfileStoreSnapshot();
  return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}

/** Replaces all runtime auth profile snapshots with cloned entries. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  if (replaceChangesCredentials(entries)) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  if (credentialState(runtimeAuthStoreSnapshots).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshots.clear();
}

/** Stores a cloned runtime auth profile snapshot for an agent dir. */
export function setRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore,
  agentDir?: string,
): void {
  const key = resolveRuntimeStoreKey(agentDir);
  if (!isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key)?.profiles ?? {}, store.profiles)) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshots.set(key, cloneAuthProfileStore(store));
}

/**
 * Invalidates prepared credential ownership after a persisted owner-store write.
 * Main-store credentials are inherited by custom-agent snapshots, so those
 * derived snapshots must be dropped even when no exact main snapshot exists.
 */
export function noteRuntimeAuthProfileStoreCredentialsChanged(
  agentDir: string | undefined,
  mutation: { profileIds: Iterable<string> },
): void {
  runtimeAuthStoreCredentialsRevision += 1;
  const ownerKey = resolveRuntimeStoreKey(agentDir);
  persistedStoreMutationRevision.set(ownerKey, runtimeAuthStoreCredentialsRevision);
  let profileRevisions = persistedProfileMutationRevision.get(ownerKey);
  for (const profileId of mutation.profileIds) {
    profileRevisions ??= new Map<string, number>();
    profileRevisions.set(profileId, runtimeAuthStoreCredentialsRevision);
  }
  if (profileRevisions) {
    persistedProfileMutationRevision.set(ownerKey, profileRevisions);
  }
  const mainKey = resolveRuntimeStoreKey(undefined);
  if (ownerKey !== mainKey) {
    return;
  }
  for (const key of runtimeAuthStoreSnapshots.keys()) {
    if (key !== mainKey) {
      runtimeAuthStoreSnapshots.delete(key);
    }
  }
}

/** Persisted mutation token for one store or profile credential. */
export function getRuntimeAuthProfileStoreCredentialMutationRevision(
  agentDir?: string,
  profileId?: string,
): number {
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  if (!profileId) {
    return persistedStoreMutationRevision.get(requestedKey) ?? 0;
  }
  const mainKey = resolveRuntimeStoreKey(undefined);
  const keys = requestedKey === mainKey ? [mainKey] : [requestedKey, mainKey];
  return Math.max(
    0,
    ...keys.map((key) => persistedProfileMutationRevision.get(key)?.get(profileId) ?? 0),
  );
}

/** Stable token for credential ownership without coupling to usage bookkeeping. */
export function getRuntimeAuthProfileStoreCredentialsRevision(): number {
  return runtimeAuthStoreCredentialsRevision;
}
