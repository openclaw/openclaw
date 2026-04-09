import fs from "node:fs";
import { withFileLock } from "../../infra/file-lock.js";
import { saveJsonFile } from "../../infra/json-file.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  AUTH_STORE_VERSION,
  EXTERNAL_CLI_SYNC_TTL_MS,
  log,
} from "./constants.js";
import { overlayExternalAuthProfiles, shouldPersistExternalAuthProfile } from "./external-auth.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import {
  ensureAuthStoreFile,
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./paths.js";
import {
  applyLegacyAuthStore,
  buildPersistedAuthProfileSecretsStore,
  loadLegacyAuthProfileStore,
  loadPersistedAuthProfileStore,
  mergeAuthProfileStores,
  mergeOAuthFileIntoStore,
} from "./persisted.js";
import { savePersistedAuthProfileState } from "./state.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
  syncExternalCli?: boolean;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
};

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();
const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();
const staleRuntimeAuthStoreSnapshotKeys = new Set<string>();

// Map of auth store path -> mtime when the runtime snapshot was loaded.
// Used to detect if a specific on-disk auth-profiles.json was modified externally
// (e.g. by `openclaw models auth login` while gateway was stopped) and invalidate
// stale runtime snapshots on startup.
const runtimeSnapshotMtimes = new Map<string, number>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function invalidateRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
  runtimeSnapshotMtimes.clear();
  staleRuntimeAuthStoreSnapshotKeys.clear();
}

function invalidateRuntimeAuthProfileStoreSnapshot(agentDir?: string): void {
  const key = resolveRuntimeStoreKey(agentDir);
  runtimeAuthStoreSnapshots.delete(key);
  staleRuntimeAuthStoreSnapshotKeys.add(key);
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  if (runtimeAuthStoreSnapshots.size === 0) {
    return null;
  }

  const mainKey = resolveRuntimeStoreKey(undefined);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const requestedAuthPath = resolveAuthStorePath(agentDir);

  // Staleness detection: if the on-disk auth-profiles.json was modified after
  // the runtime snapshot was loaded (e.g. by `openclaw models auth login` while
  // gateway was stopped), invalidate the snapshot so callers fall through to a
  // fresh disk read. This prevents overwriting fresh tokens with stale cached state.
  // Check main store staleness (always checked).
  const mainLoadedMtime = runtimeSnapshotMtimes.get(mainKey);
  if (mainLoadedMtime !== undefined) {
    const mainMtime = readAuthStoreMtimeMs(mainAuthPath);
    if (mainMtime !== null && mainMtime > mainLoadedMtime) {
      invalidateRuntimeAuthProfileStoreSnapshots();
      return null;
    }
  }

  // Check agent-specific store staleness only when it differs from main.
  if (requestedKey !== mainKey) {
    const requestedLoadedMtime = runtimeSnapshotMtimes.get(requestedKey);
    if (requestedLoadedMtime !== undefined) {
      const requestedMtime = readAuthStoreMtimeMs(requestedAuthPath);
      if (requestedMtime !== null && requestedMtime > requestedLoadedMtime) {
        invalidateRuntimeAuthProfileStoreSnapshot(agentDir);
        return null;
      }
    }
  }

  const mainStore = runtimeAuthStoreSnapshots.get(mainKey);
  const requestedStore = runtimeAuthStoreSnapshots.get(requestedKey);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return cloneAuthProfileStore(mainStore);
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(
      cloneAuthProfileStore(mainStore),
      cloneAuthProfileStore(requestedStore),
    );
  }
  if (requestedStore) {
    return cloneAuthProfileStore(requestedStore);
  }
  if (staleRuntimeAuthStoreSnapshotKeys.has(requestedKey)) {
    return null;
  }
  if (mainStore) {
    return cloneAuthProfileStore(mainStore);
  }

  return null;
}

function hasStoredAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
  snapshotMtimes?: Record<string, number>,
): void {
  // Clear stale mtime keys from prior activations before populating fresh ones.
  // This prevents removed agent paths from causing false-positive staleness detection.
  runtimeSnapshotMtimes.clear();
  staleRuntimeAuthStoreSnapshotKeys.clear();

  // Capture mtime for each auth store file represented by entries.
  // Use snapshotMtimes from prepare time if available, otherwise stat at activation time.
  // Recording mtime at prepare time (not activation) closes the race window between
  // prepareSecretsRuntimeSnapshot reading the store and this function capturing mtime.
  for (const entry of entries) {
    const authPath = resolveAuthStorePath(entry.agentDir);
    const key = resolveRuntimeStoreKey(entry.agentDir);
    const agentDirKey = entry.agentDir ?? "";
    const mtime = snapshotMtimes?.[agentDirKey] ?? readAuthStoreMtimeMs(authPath) ?? Date.now();
    runtimeSnapshotMtimes.set(key, mtime);
  }

  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    const key = resolveRuntimeStoreKey(entry.agentDir);
    staleRuntimeAuthStoreSnapshotKeys.delete(key);
    runtimeAuthStoreSnapshots.set(key, cloneAuthProfileStore(entry.store));
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  invalidateRuntimeAuthProfileStoreSnapshots();
  loadedAuthStoreCache.clear();
}

function readAuthStoreMtimeMs(authPath: string): number | null {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function readCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.authPath);
  if (
    !cached ||
    cached.authMtimeMs !== params.authMtimeMs ||
    cached.stateMtimeMs !== params.stateMtimeMs
  ) {
    return null;
  }
  if (Date.now() - cached.syncedAtMs >= EXTERNAL_CLI_SYNC_TTL_MS) {
    return null;
  }
  return cloneAuthProfileStore(cached.store);
}

function writeCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.authPath, {
    authMtimeMs: params.authMtimeMs,
    stateMtimeMs: params.stateMtimeMs,
    syncedAtMs: Date.now(),
    store: cloneAuthProfileStore(params.store),
  });
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      // Locked writers must reload from disk, not from any runtime snapshot.
      // Otherwise a live gateway can overwrite fresher CLI/config-auth writes
      // with stale in-memory auth state during usage/cooldown updates.
      const store = loadAuthProfileStoreForAgent(params.agentDir);
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
      }
      return store;
    });
  } catch {
    return null;
  }
}

function shouldLogAuthStoreTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function syncExternalCliCredentialsTimed(
  store: AuthProfileStore,
  options?: Parameters<typeof syncExternalCliCredentials>[1],
): boolean {
  if (!shouldLogAuthStoreTiming()) {
    return syncExternalCliCredentials(store, options);
  }
  const startMs = Date.now();
  const mutated = syncExternalCliCredentials(store, options);
  log.info(
    `auth-store stage=external-cli-sync elapsedMs=${Date.now() - startMs} mutated=${mutated}`,
  );
  return mutated;
}

function shouldSyncExternalCliCredentials(options?: { syncExternalCli?: boolean }): boolean {
  return options?.syncExternalCli !== false;
}

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    // Sync from external CLI tools on every load.
    syncExternalCliCredentialsTimed(asStore);
    return overlayExternalAuthProfiles(asStore);
  }
  const legacy = loadLegacyAuthProfileStore();
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyAuthStore(store, legacy);
    syncExternalCliCredentialsTimed(store);
    return overlayExternalAuthProfiles(store);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  syncExternalCliCredentialsTimed(store);
  return overlayExternalAuthProfiles(store);
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const authMtimeMs = readAuthStoreMtimeMs(authPath);
  const stateMtimeMs = readAuthStoreMtimeMs(statePath);
  if (!readOnly) {
    const cached = readCachedAuthProfileStore({
      authPath,
      authMtimeMs,
      stateMtimeMs,
    });
    if (cached) {
      return cached;
    }
  }
  const asStore = loadPersistedAuthProfileStore(agentDir);
  if (asStore) {
    // Runtime secret activation must remain read-only:
    // sync external CLI credentials in-memory, but never persist while readOnly.
    if (shouldSyncExternalCliCredentials(options)) {
      syncExternalCliCredentialsTimed(asStore, { log: !readOnly });
    }
    if (!readOnly) {
      writeCachedAuthProfileStore({
        authPath,
        authMtimeMs: readAuthStoreMtimeMs(authPath),
        stateMtimeMs: readAuthStoreMtimeMs(statePath),
        store: asStore,
      });
    }
    return asStore;
  }

  // Fallback: inherit auth-profiles from main agent if subagent has none
  if (agentDir && !readOnly) {
    const mainStore = loadPersistedAuthProfileStore();
    if (mainStore && Object.keys(mainStore.profiles).length > 0) {
      // Clone only secret-bearing profiles to subagent directory for auth inheritance.
      saveJsonFile(authPath, buildPersistedAuthProfileSecretsStore(mainStore));
      log.info("inherited auth-profiles from main agent", { agentDir });
      const inherited = { version: mainStore.version, profiles: { ...mainStore.profiles } };
      writeCachedAuthProfileStore({
        authPath,
        authMtimeMs: readAuthStoreMtimeMs(authPath),
        stateMtimeMs: readAuthStoreMtimeMs(statePath),
        store: inherited,
      });
      return inherited;
    }
  }

  const legacy = loadLegacyAuthProfileStore(agentDir);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyAuthStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  // Keep external CLI credentials visible in runtime even during read-only loads.
  if (shouldSyncExternalCliCredentials(options)) {
    syncExternalCliCredentialsTimed(store, { log: !readOnly });
  }
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth);
  if (shouldWrite) {
    saveAuthProfileStore(store, agentDir);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  if (!readOnly) {
    writeCachedAuthProfileStore({
      authPath,
      authMtimeMs: readAuthStoreMtimeMs(authPath),
      stateMtimeMs: readAuthStoreMtimeMs(statePath),
      store,
    });
  }
  return store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return overlayExternalAuthProfiles(store, { agentDir });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return overlayExternalAuthProfiles(mergeAuthProfileStores(mainStore, store), {
    agentDir,
  });
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return overlayExternalAuthProfiles(runtimeStore, { agentDir });
  }

  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return overlayExternalAuthProfiles(store, { agentDir });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const merged = mergeAuthProfileStores(mainStore, store);

  return overlayExternalAuthProfiles(merged, { agentDir });
}

export function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { syncExternalCli: false };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, {
    readOnly: true,
    syncExternalCli: false,
  });
  return mergeAuthProfileStores(mainStore, store);
}

export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore && Object.keys(runtimeStore.profiles).length > 0) {
    return true;
  }

  if (hasStoredAuthProfileFiles(agentDir)) {
    return true;
  }

  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (agentDir && authPath !== mainAuthPath && hasStoredAuthProfileFiles(undefined)) {
    return true;
  }

  return false;
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const runtimeKey = resolveRuntimeStoreKey(agentDir);
  const payload = buildPersistedAuthProfileSecretsStore(store, ({ profileId, credential }) => {
    if (credential.type !== "oauth") {
      return true;
    }
    if (options?.filterExternalAuthProfiles === false) {
      return true;
    }
    return shouldPersistExternalAuthProfile({
      store,
      profileId,
      credential,
      agentDir,
    });
  });
  saveJsonFile(authPath, payload);
  savePersistedAuthProfileState(store, agentDir);
  const runtimeStore = cloneAuthProfileStore(store);
  if (shouldSyncExternalCliCredentials(options)) {
    syncExternalCliCredentialsTimed(runtimeStore, { log: false });
  }
  const authMtimeMs = readAuthStoreMtimeMs(authPath);
  const stateMtimeMs = readAuthStoreMtimeMs(statePath);
  writeCachedAuthProfileStore({
    authPath,
    authMtimeMs,
    stateMtimeMs,
    store: runtimeStore,
  });
  if (authMtimeMs !== null) {
    runtimeSnapshotMtimes.set(runtimeKey, authMtimeMs);
  }
  if (runtimeAuthStoreSnapshots.has(runtimeKey)) {
    staleRuntimeAuthStoreSnapshotKeys.delete(runtimeKey);
    runtimeAuthStoreSnapshots.set(runtimeKey, cloneAuthProfileStore(runtimeStore));
  }
}
