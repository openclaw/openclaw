/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { loadCandidateAuthProfileStore } from "./candidate-stores.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { withOAuthProfileLocks, type OAuthProfileLockKey } from "./oauth-profile-lock.js";
import {
  listOAuthRefreshGenerationPeers,
  removeOAuthRefreshGenerationPeers,
  type OAuthRefreshGenerationPeer,
} from "./oauth-refresh-peers.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import { removeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import {
  isSharedMainAuthProfileAgentDir,
  resolvePersistedAuthProfileOwnerAgentDir,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export { upsertAuthProfileWithLock, upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

const authProfileProfilesLog = createSubsystemLogger("agent/embedded");
const OAUTH_REMOVAL_MAX_ATTEMPTS = 3;

function listProviderAuthStateEntries<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): Array<[string, T]> {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  return Object.entries(entries ?? {})
    .filter(([key]) => resolveProviderIdForAuth(key) === canonicalProvider)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function readProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  const matches = listProviderAuthStateEntries(entries, canonicalProvider);
  return (
    matches.find(([key]) => normalizeProviderId(key) === canonicalProvider)?.[1] ?? matches[0]?.[1]
  );
}

function replaceProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  value?: T,
): Record<string, T> | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => resolveProviderIdForAuth(key) !== canonicalProvider,
    ),
  ) as Record<string, T>;
  if (value !== undefined) {
    next[canonicalProvider] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Sets or clears explicit auth profile order for a provider. */
export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
  sharedStoreWrite?: boolean;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    sharedStoreWrite: params.sharedStoreWrite,
    // Preserve requested IDs that the agent inherits (not owns) so the local
    // save path does not prune them from the order. Without this, a secondary
    // agent's `models auth order set --agent` accepts an inherited profile ID
    // (validated against the merged store) but drops it while persisting, so
    // `order get` falls back to the inherited main order — the CLI reports a
    // switch that never happened (issue #119233). Mirrors the adjacent
    // promoteAuthProfileInOrder preservation contract; the clear-order path
    // (deduped.length === 0) must not preserve anything.
    ...(deduped.length > 0 ? { saveOptions: { preserveOrderProfileIds: deduped } } : {}),
    updater: (store) => {
      if (deduped.length === 0) {
        if (listProviderAuthStateEntries(store.order, providerKey).length === 0) {
          return false;
        }
        store.order = replaceProviderAuthState(store.order, providerKey);
        return true;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, deduped);
      return true;
    },
  });
}

/** Promotes across shared-credential/local-order owners; otherwise relogin leaves stale order. */
export async function promoteAuthProfileInOrder(params: {
  agentDir?: string;
  provider: string;
  profileId: string;
  createIfMissing?: boolean;
  createFromOrder?: string[];
}): Promise<Result<AuthProfileStore, "lock-contention">> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  const effectiveStore = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    saveOptions: { preserveOrderProfileIds: [params.profileId, ...(params.createFromOrder ?? [])] },
    updater: (store) => {
      const profile = store.profiles[params.profileId] ?? effectiveStore.profiles[params.profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      const matchingOrderEntries = listProviderAuthStateEntries(store.order, providerKey);
      const existing = readProviderAuthState(store.order, providerKey);
      if (!existing || existing.length === 0) {
        if (!params.createIfMissing) {
          return false;
        }
        const providerProfiles = dedupeProfileIds(
          params.createFromOrder !== undefined
            ? params.createFromOrder
            : listProfilesForProvider(store, providerKey),
        );
        const next = dedupeProfileIds([
          params.profileId,
          ...providerProfiles.filter((profileId) => profileId !== params.profileId),
        ]);
        store.order = replaceProviderAuthState(store.order, providerKey, next);
        return true;
      }
      const next = dedupeProfileIds([
        params.profileId,
        ...existing.filter((profileId) => profileId !== params.profileId),
      ]);
      if (
        next.length === existing.length &&
        next.every((profileId, idx) => profileId === existing[idx]) &&
        matchingOrderEntries.length === 1 &&
        matchingOrderEntries[0]?.[0] === providerKey
      ) {
        return false;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, next);
      return true;
    },
  });
  return updated === null ? err("lock-contention") : ok(updated);
}

/** Upserts an auth profile immediately into the local store. */
export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential = normalizeAuthProfileCredential(params.credential);
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir, {
    filterExternalAuthProfiles: false,
    sharedStoreWrite: true,
    syncExternalCli: false,
  });
}

function providerAuthStoreOwners(requestedAgentDir?: string): Array<string | undefined> {
  const agentDir = resolveRuntimeAuthProfileAgentDir(requestedAgentDir);
  const owners: Array<string | undefined> = [agentDir];
  if (
    agentDir &&
    !isSharedMainAuthProfileAgentDir(agentDir) &&
    resolveAuthProfileDatabasePath(agentDir) ===
      resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir())
  ) {
    // Main login writes shared credentials; clear that owner before its local overrides.
    // Other agents must not erase credentials inherited from the shared store.
    owners.unshift(undefined);
  }
  return owners;
}

/** Removes auth profiles and related state for a provider, optionally narrowed to exact IDs. */
export async function removeProviderAuthProfilesWithLock(params: {
  cfg?: OpenClawConfig;
  provider: string;
  agentDir?: string;
  profileIds?: readonly string[];
}): Promise<AuthProfileStore | null> {
  const owners = providerAuthStoreOwners(params.agentDir);
  for (let attempt = 0; attempt < OAUTH_REMOVAL_MAX_ATTEMPTS; attempt += 1) {
    const targets = owners.map((owner) =>
      createAuthProfileRemovalTarget({
        agentDir: owner,
        ...(params.profileIds
          ? { profileIds: new Set(params.profileIds) }
          : { provider: params.provider }),
      }),
    );
    const result = await removeAuthProfileTargetsWithLocks(targets, params.cfg ?? {});
    if (result.kind === "updated") {
      return result.stores.at(-1) ?? null;
    }
    if (result.kind === "contention") {
      return null;
    }
  }
  return null;
}

function removeProfileReferences(
  store: AuthProfileStore,
  profileIds: ReadonlySet<string>,
  provider?: string,
): boolean {
  const next = { ...removeRuntimeExternalProfileReferences({ store, profileIds }) };
  if (provider !== undefined && next.order) {
    next.order = replaceProviderAuthState(next.order, provider);
  }
  if (provider !== undefined && next.lastGood) {
    next.lastGood = replaceProviderAuthState(next.lastGood, provider);
  }
  if (isDeepStrictEqual(store, next)) {
    return false;
  }
  Object.assign(store, next);
  return true;
}

type AuthProfileRemovalTarget = {
  agentDir?: string;
  databasePath: string;
  profileIds: ReadonlySet<string>;
  provider?: string;
  expectedProfiles: ReadonlyMap<string, AuthProfileCredential | undefined>;
};

function createAuthProfileRemovalTarget(params: {
  agentDir?: string;
  profileIds?: ReadonlySet<string>;
  provider?: string;
}): AuthProfileRemovalTarget {
  // Removal compares the physical write target, without inherited credentials.
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
    allowKeychainPrompt: false,
    inheritedAuthDir: params.agentDir,
  });
  const profileIds =
    params.profileIds ?? new Set(listProfilesForProvider(store, params.provider ?? ""));
  return {
    agentDir: params.agentDir,
    databasePath: resolvePathViaExistingAncestorSync(
      params.agentDir
        ? resolveAuthProfileDatabasePath(params.agentDir)
        : resolveSharedAuthStorePath(),
    ),
    profileIds,
    ...(params.provider ? { provider: params.provider } : {}),
    expectedProfiles: new Map(
      [...profileIds].map((profileId) => [profileId, store.profiles[profileId]]),
    ),
  };
}

function authProfileRemovalTargetMatches(
  target: AuthProfileRemovalTarget,
  store: AuthProfileStore,
): boolean {
  if (target.provider) {
    const currentProfileIds = new Set(listProfilesForProvider(store, target.provider));
    if (
      currentProfileIds.size !== target.profileIds.size ||
      [...currentProfileIds].some((profileId) => !target.profileIds.has(profileId))
    ) {
      return false;
    }
  }
  return [...target.expectedProfiles].every(([profileId, expected]) =>
    isDeepStrictEqual(store.profiles[profileId], expected),
  );
}

type AuthProfileRemovalResult =
  | { kind: "retry" }
  | { kind: "contention" }
  | { kind: "updated"; stores: AuthProfileStore[] };

/** Physical credential owners affected by one explicit removal. No secret material. */
export type AuthProfileRemovalScope = {
  readonly agentDir?: string;
  readonly databasePath: string;
  readonly profileIds: readonly string[];
};

async function prepareAuthProfileRemovalPeers(
  targets: readonly AuthProfileRemovalTarget[],
  cfg: OpenClawConfig,
): Promise<OAuthRefreshGenerationPeer[]> {
  const peers = new Map<string, OAuthRefreshGenerationPeer>();
  for (const target of targets) {
    for (const [profileId, credential] of target.expectedProfiles) {
      if (credential?.type !== "oauth") {
        continue;
      }
      for (const peer of await listOAuthRefreshGenerationPeers({
        cfg,
        ownerDatabasePath: target.databasePath,
        profileId,
        generation: credential,
      })) {
        // Direct targets own their reference cleanup and generation check already.
        if (
          !targets.some(
            (owner) =>
              owner.databasePath === peer.candidate.databasePath && owner.profileIds.has(profileId),
          )
        ) {
          peers.set(`${peer.candidate.databasePath}\0${profileId}`, peer);
        }
      }
    }
  }
  return [...peers.values()];
}

function readRemovalProfileState(
  targets: readonly AuthProfileRemovalTarget[],
  peers: readonly OAuthRefreshGenerationPeer[],
  current = false,
): { profiles: ReadonlyMap<string, AuthProfileCredential>; scopes: AuthProfileRemovalScope[] } {
  const profiles = new Map<string, AuthProfileCredential>();
  const scopes = new Map<
    string,
    { agentDir?: string; databasePath: string; profileIds: string[] }
  >();
  const add = (
    owner: { agentDir?: string; databasePath: string },
    profileId: string,
    credential: AuthProfileCredential | undefined,
  ) => {
    if (!credential) {
      return;
    }
    profiles.set(profileId, credential);
    let scope = scopes.get(owner.databasePath);
    if (!scope) {
      scope = { agentDir: owner.agentDir, databasePath: owner.databasePath, profileIds: [] };
      scopes.set(owner.databasePath, scope);
    }
    if (!scope.profileIds.includes(profileId)) {
      scope.profileIds.push(profileId);
    }
  };
  for (const target of targets) {
    const store = current
      ? loadAuthProfileStoreWithoutExternalProfiles(target.agentDir, {
          allowKeychainPrompt: false,
          inheritedAuthDir: target.agentDir,
        })
      : undefined;
    for (const profileId of target.profileIds) {
      add(
        target,
        profileId,
        current ? store?.profiles[profileId] : target.expectedProfiles.get(profileId),
      );
    }
  }
  for (const peer of peers) {
    const credential = current
      ? loadCandidateAuthProfileStore(peer.candidate)?.profiles[peer.profileId]
      : peer.credential;
    add(peer.candidate, peer.profileId, credential);
  }
  return { profiles, scopes: [...scopes.values()] };
}

async function removeAuthProfileTargetsWithLocks(
  targets: readonly AuthProfileRemovalTarget[],
  cfg: OpenClawConfig,
): Promise<AuthProfileRemovalResult> {
  const lockKeys: OAuthProfileLockKey[] = targets.flatMap((target) =>
    [...target.expectedProfiles].flatMap(([profileId, credential]) =>
      credential?.type === "oauth" ? [{ profileId, provider: credential.provider }] : [],
    ),
  );
  return await withOAuthProfileLocks(lockKeys, async () => {
    for (const target of targets) {
      const current = loadAuthProfileStoreWithoutExternalProfiles(target.agentDir, {
        allowKeychainPrompt: false,
        inheritedAuthDir: target.agentDir,
      });
      if (!authProfileRemovalTargetMatches(target, current)) {
        return { kind: "retry" };
      }
    }

    removeOAuthRefreshGenerationPeers(await prepareAuthProfileRemovalPeers(targets, cfg));

    const stores: AuthProfileStore[] = [];
    for (const target of targets) {
      let stale = false;
      const updated = await updateAuthProfileStoreWithLock({
        agentDir: target.agentDir,
        updater: (store) => {
          if (!authProfileRemovalTargetMatches(target, store)) {
            stale = true;
            return false;
          }
          return removeProfileReferences(store, target.profileIds, target.provider);
        },
      });
      if (updated === null) {
        return { kind: "contention" };
      }
      if (stale) {
        return { kind: "retry" };
      }
      stores.push(updated);
    }
    return { kind: "updated", stores };
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStores(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  agentDir?: string;
  profileIds: readonly string[];
  beforeRemove?: (
    profileIds: readonly string[],
    scopes: readonly AuthProfileRemovalScope[],
  ) => Promise<void>;
  onIncomplete?: (
    survivingProfiles: ReadonlyMap<string, AuthProfileCredential>,
    scopes: readonly AuthProfileRemovalScope[],
  ) => Promise<void>;
}): Promise<boolean> {
  const profileIds = new Set(params.profileIds);
  if ([...profileIds].some(isUserModelAuthProfileId)) {
    throw new Error(
      "Personal model accounts are managed in Settings → Profile → Connected accounts. Clearing a default keeps the credential; revoke access with the provider instead of removing a shared auth profile.",
    );
  }
  for (let attempt = 0; attempt < OAUTH_REMOVAL_MAX_ATTEMPTS; attempt += 1) {
    const owners =
      params.provider === undefined ? [params.agentDir] : providerAuthStoreOwners(params.agentDir);
    // An explicit main dir and the implicit shared owner can name one legacy database.
    // Capture it once, or the first removal makes its duplicate target look stale.
    const profilesByOwner = new Map(
      owners.map((owner) => [
        isSharedMainAuthProfileAgentDir(owner) ? undefined : owner,
        new Set(profileIds),
      ]),
    );
    for (const profileId of profileIds) {
      const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      });
      const ownerProfiles = profilesByOwner.get(ownerAgentDir) ?? new Set<string>();
      ownerProfiles.add(profileId);
      profilesByOwner.set(ownerAgentDir, ownerProfiles);
    }
    const targets = [...profilesByOwner].map(([agentDir, ownerProfileIds]) =>
      createAuthProfileRemovalTarget({
        agentDir,
        ...(params.provider !== undefined
          ? { provider: params.provider }
          : { profileIds: ownerProfileIds }),
      }),
    );
    const peers =
      params.beforeRemove || params.onIncomplete
        ? await prepareAuthProfileRemovalPeers(targets, params.cfg ?? {})
        : [];
    const reconcileSurvivors = async () => {
      if (!params.onIncomplete) {
        return;
      }
      const surviving = readRemovalProfileState(targets, peers, true);
      await params.onIncomplete(surviving.profiles, surviving.scopes);
    };
    // Config cleanup must not make a later credential generation eligible for this removal.
    let result: AuthProfileRemovalResult;
    try {
      await params.beforeRemove?.(
        [...new Set(targets.flatMap((target) => [...target.profileIds]))],
        readRemovalProfileState(targets, peers).scopes,
      );
      result = await removeAuthProfileTargetsWithLocks(targets, params.cfg ?? {});
    } catch (error) {
      await reconcileSurvivors();
      throw error;
    }
    if (result.kind === "updated") {
      if (params.onIncomplete) {
        const surviving = readRemovalProfileState(targets, peers, true);
        // A captured peer may have reconnected while config cleanup was awaiting I/O.
        if (surviving.profiles.size > 0) {
          await params.onIncomplete(surviving.profiles, surviving.scopes);
        }
      }
      return true;
    }
    if (result.kind === "contention" || params.beforeRemove) {
      await reconcileSurvivors();
      return false;
    }
  }
  return false;
}

/** Clear the last-good profile pointer for a provider under the store lock. */
export async function clearLastGoodProfileWithLock(params: {
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    profileId: params.profileId,
    updater: (store) => {
      const matches = listProviderAuthStateEntries(store.lastGood, providerKey);
      if (!matches.some(([, profileId]) => profileId === params.profileId)) {
        return false;
      }
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey);
      return true;
    },
  });
}

/** Mark a profile as successfully used and update ordering/usage metadata. */
export async function markAuthProfileSuccess(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const providerKey = resolveProviderIdForAuth(provider);
  const profile = store.profiles[profileId];
  if (
    !profile ||
    profile.setup?.replacement ||
    resolveProviderIdForAuth(profile.provider) !== providerKey
  ) {
    return;
  }
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId });
  const personal = isUserModelAuthProfileId(profileId);
  const inherited =
    !personal && ownerAgentDir === undefined && !isSharedMainAuthProfileAgentDir(agentDir);
  const updatesSelection = !inherited && !personal;
  const lastUsed = Date.now();
  let applied = false;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: ownerAgentDir,
    profileId,
    updater: (freshStore) => {
      const freshProfile = freshStore.profiles[profileId];
      if (
        !freshProfile ||
        freshProfile.setup?.replacement ||
        resolveProviderIdForAuth(freshProfile.provider) !== providerKey
      ) {
        return false;
      }
      // Inherited selection ownership is not defined. Clear shared health in
      // the credential owner without changing its last-good or rotation state.
      if (updatesSelection) {
        freshStore.lastGood = replaceProviderAuthState(freshStore.lastGood, providerKey, profileId);
      }
      freshStore.usageStats ??= {};
      freshStore.usageStats[profileId] = resetAuthProfileFailureState(
        freshStore.usageStats[profileId] ?? {},
        { lastProbeAt: Date.now(), ...(inherited ? {} : { lastUsed }) },
      );
      applied = true;
      return true;
    },
  });
  if (updated && applied) {
    const usage = updated.usageStats?.[profileId];
    if (usage) {
      store.usageStats = { ...store.usageStats, [profileId]: usage };
    }
    if (updatesSelection) {
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey, profileId);
    }
    return;
  }
  if (updated === null) {
    authProfileProfilesLog.warn(
      "dropped auth profile bookkeeping after locked store update failed",
      {
        event: "auth_profile_bookkeeping_dropped",
        kind: "success",
        profileId,
        tags: ["auth_profiles", "persistence"],
      },
    );
  }
}
