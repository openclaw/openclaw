import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withFileLock } from "../../infra/file-lock.js";
import { saveJsonFile } from "../../infra/json-file.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { cloneAuthProfileStore } from "./clone.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  AUTH_STORE_VERSION,
  EXTERNAL_CLI_SYNC_TTL_MS,
  log,
} from "./constants.js";
import {
  overlayExternalAuthProfiles,
  shouldPersistExternalAuthProfile,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
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
import {
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { savePersistedAuthProfileState } from "./state.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
};

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SyncLockSnapshot = {
  raw: string;
  stat: fs.Stats;
  payload: Record<string, unknown> | null;
};

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();

function isInheritedMainOAuthCredential(params: {
  agentDir?: string;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
}): boolean {
  if (!params.agentDir || params.credential.type !== "oauth") {
    return false;
  }
  const authPath = resolveAuthStorePath(params.agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (authPath === mainAuthPath) {
    return false;
  }

  const localStore = loadPersistedAuthProfileStore(params.agentDir);
  if (localStore?.profiles[params.profileId]) {
    return false;
  }

  const mainCredential = loadPersistedAuthProfileStore()?.profiles[params.profileId];
  return (
    mainCredential?.type === "oauth" &&
    (isDeepStrictEqual(mainCredential, params.credential) ||
      shouldUseMainOwnerForLocalOAuthCredential({
        local: params.credential,
        main: mainCredential,
      }))
  );
}

function shouldUseMainOwnerForLocalOAuthCredential(params: {
  local: AuthProfileStore["profiles"][string];
  main: AuthProfileStore["profiles"][string] | undefined;
}): boolean {
  if (params.local.type !== "oauth" || params.main?.type !== "oauth") {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) {
    return false;
  }
  if (isDeepStrictEqual(params.local, params.main)) {
    return true;
  }
  return (
    Number.isFinite(params.main.expires) &&
    (!Number.isFinite(params.local.expires) || params.main.expires >= params.local.expires)
  );
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  const mainKey = resolveAuthStorePath(undefined);
  const requestedKey = resolveAuthStorePath(agentDir);
  const mainStore = getRuntimeAuthProfileStoreSnapshot(undefined);
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return mainStore;
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore);
  }
  if (requestedStore) {
    const persistedMainStore = loadAuthProfileStoreForAgent(undefined, {
      readOnly: true,
      syncExternalCli: false,
    });
    return mergeAuthProfileStores(persistedMainStore, requestedStore);
  }
  if (mainStore) {
    return mainStore;
  }

  return null;
}

function readAuthStoreMtimeMs(authPath: string): number | null {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function computeAuthStoreLockDelayMs(attempt: number): number {
  const retry = AUTH_STORE_LOCK_OPTIONS.retries;
  const base = Math.min(
    retry.maxTimeout,
    Math.max(retry.minTimeout, retry.minTimeout * retry.factor ** attempt),
  );
  return retry.randomize ? Math.round(base * (1 + Math.random())) : base;
}

function readSyncLockSnapshot(lockPath: string): SyncLockSnapshot | null {
  try {
    const stat = fs.lstatSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      payload = null;
    }
    return { raw, stat, payload };
  } catch {
    return null;
  }
}

function syncLockSnapshotMatches(lockPath: string, snapshot: SyncLockSnapshot): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    return (
      stat.dev === snapshot.stat.dev &&
      stat.ino === snapshot.stat.ino &&
      fs.readFileSync(lockPath, "utf8") === snapshot.raw
    );
  } catch {
    return false;
  }
}

function shouldReclaimSyncAuthStoreLock(snapshot: SyncLockSnapshot, nowMs: number): boolean {
  const pid = snapshot.payload?.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) {
    return true;
  }
  const createdAt = snapshot.payload?.createdAt;
  if (typeof createdAt === "string") {
    const createdAtMs = Date.parse(createdAt);
    return !Number.isFinite(createdAtMs) || nowMs - createdAtMs > AUTH_STORE_LOCK_OPTIONS.stale;
  }
  return nowMs - snapshot.stat.mtimeMs > AUTH_STORE_LOCK_OPTIONS.stale;
}

function acquireAuthStoreLockSync(authPath: string): (() => void) | null {
  const lockPath = `${authPath}.lock`;
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  for (let attempt = 0; attempt <= AUTH_STORE_LOCK_OPTIONS.retries.retries; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const raw = `${JSON.stringify(
        { pid: process.pid, createdAt: new Date().toISOString() },
        null,
        2,
      )}\n`;
      try {
        fs.writeFileSync(fd, raw, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      const snapshot = readSyncLockSnapshot(lockPath);
      return () => {
        if (snapshot && syncLockSnapshotMatches(lockPath, snapshot)) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw err;
      }
      const snapshot = readSyncLockSnapshot(lockPath);
      if (!snapshot) {
        continue;
      }
      if (shouldReclaimSyncAuthStoreLock(snapshot, Date.now())) {
        if (syncLockSnapshotMatches(lockPath, snapshot)) {
          fs.rmSync(lockPath, { force: true });
        }
        continue;
      }
      if (attempt >= AUTH_STORE_LOCK_OPTIONS.retries.retries) {
        return null;
      }
      const delayMs = computeAuthStoreLockDelayMs(attempt);
      sleepSync(delayMs);
    }
  }
  return null;
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

function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ResolvedExternalCliOverlayOptions {
  const discovery = options?.externalCli;
  if (!discovery) {
    return {
      ...(options?.allowKeychainPrompt !== undefined
        ? { allowKeychainPrompt: options.allowKeychainPrompt }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.externalCliProviderIds
        ? { externalCliProviderIds: options.externalCliProviderIds }
        : {}),
      ...(options?.externalCliProfileIds
        ? { externalCliProfileIds: options.externalCliProfileIds }
        : {}),
    };
  }
  if (discovery.mode === "none") {
    const config = discovery.config ?? options?.config;
    return {
      allowKeychainPrompt: false,
      ...(config ? { config } : {}),
      externalCliProviderIds: [],
      externalCliProfileIds: [],
    };
  }
  if (discovery.mode === "existing") {
    const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
    const config = discovery.config ?? options?.config;
    return {
      ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
      ...(config ? { config } : {}),
    };
  }
  const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
  const config = discovery.config ?? options?.config;
  return {
    ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
    ...(config ? { config } : {}),
    ...(discovery.providerIds ? { externalCliProviderIds: discovery.providerIds } : {}),
    ...(discovery.profileIds ? { externalCliProfileIds: discovery.profileIds } : {}),
  };
}

function maybeSyncPersistedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: LoadAuthProfileStoreOptions;
}): AuthProfileStore {
  if (
    params.options?.readOnly === true ||
    params.options?.syncExternalCli === false ||
    process.env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return params.store;
  }
  const synced = syncPersistedExternalCliAuthProfiles(params.store, {
    agentDir: params.agentDir,
    ...resolveExternalCliOverlayOptions(params.options),
  });
  if (synced === params.store) {
    return params.store;
  }
  const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
    const previous = params.store.profiles[profileId];
    return !isDeepStrictEqual(previous, credential);
  });
  if (changedProfiles.length === 0) {
    return synced;
  }

  const authPath = resolveAuthStorePath(params.agentDir);
  const release = acquireAuthStoreLockSync(authPath);
  if (!release) {
    log.warn("skipped persisted external cli auth sync because auth store is locked", {
      authPath,
    });
    return synced;
  }
  try {
    const latestStore = loadPersistedAuthProfileStore(params.agentDir) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    let changed = false;
    for (const [profileId, credential] of changedProfiles) {
      const previous = params.store.profiles[profileId];
      const latest = latestStore.profiles[profileId];
      if (!isDeepStrictEqual(latest, previous)) {
        log.debug("skipped persisted external cli auth sync for concurrently changed profile", {
          profileId,
        });
        continue;
      }
      latestStore.profiles[profileId] = credential;
      changed = true;
    }
    if (changed) {
      saveAuthProfileStore(latestStore, params.agentDir, {
        filterExternalAuthProfiles: false,
      });
      return latestStore;
    }
    return latestStore;
  } finally {
    release();
  }
}

function shouldKeepProfileInLocalStore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): boolean {
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (
    isInheritedMainOAuthCredential({
      agentDir: params.agentDir,
      profileId: params.profileId,
      credential: params.credential,
    })
  ) {
    return false;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  return shouldPersistExternalAuthProfile({
    store: params.store,
    profileId: params.profileId,
    credential: params.credential,
    agentDir: params.agentDir,
  });
}

function buildLocalAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(params.store);
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      shouldKeepProfileInLocalStore({
        store: params.store,
        profileId,
        credential,
        agentDir: params.agentDir,
        options: params.options,
      }),
    ),
  );
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  localStore.order = localStore.order
    ? Object.fromEntries(
        Object.entries(localStore.order)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter((profileId) => keptProfileIds.has(profileId)),
          ])
          .filter(([, profileIds]) => profileIds.length > 0),
      )
    : undefined;
  localStore.lastGood = localStore.lastGood
    ? Object.fromEntries(
        Object.entries(localStore.lastGood).filter(([, profileId]) =>
          keptProfileIds.has(profileId),
        ),
      )
    : undefined;
  localStore.usageStats = localStore.usageStats
    ? Object.fromEntries(
        Object.entries(localStore.usageStats).filter(([profileId]) =>
          keptProfileIds.has(profileId),
        ),
      )
    : undefined;
  return localStore;
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
      const store = loadAuthProfileStoreForAgent(params.agentDir, { syncExternalCli: false });
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

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    return overlayExternalAuthProfiles(asStore);
  }
  const legacy = loadLegacyAuthProfileStore();
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyAuthStore(store, legacy);
    return overlayExternalAuthProfiles(store);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
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
    const store = maybeSyncPersistedExternalCliAuthProfiles({
      store: asStore,
      agentDir,
      options,
    });
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

  const legacy = loadLegacyAuthProfileStore(agentDir);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyAuthStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
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

  const syncedStore = maybeSyncPersistedExternalCliAuthProfiles({
    store,
    agentDir,
    options,
  });

  if (!readOnly) {
    writeCachedAuthProfileStore({
      authPath,
      authMtimeMs: readAuthStoreMtimeMs(authPath),
      stateMtimeMs: readAuthStoreMtimeMs(statePath),
      store: syncedStore,
    });
  }
  return syncedStore;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || authPath === mainAuthPath) {
    return overlayExternalAuthProfiles(store, {
      agentDir,
      ...externalCli,
    });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return overlayExternalAuthProfiles(mergeAuthProfileStores(mainStore, store), {
    agentDir,
    ...externalCli,
  });
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

export function loadAuthProfileStoreWithoutExternalProfiles(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { readOnly: true, allowKeychainPrompt: false };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
  },
): AuthProfileStore {
  const externalCli = resolveExternalCliOverlayOptions(options);
  return overlayExternalAuthProfiles(
    ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options),
    {
      agentDir,
      ...externalCli,
    },
  );
}

export function ensureAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined {
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile || !params.agentDir) {
    return requestedProfile;
  }

  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return requestedProfile;
  }

  return loadPersistedAuthProfileStore()?.profiles[params.profileId];
}

export function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined {
  if (!params.agentDir) {
    return undefined;
  }
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return undefined;
  }

  const mainStore = loadPersistedAuthProfileStore();
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile) {
    return shouldUseMainOwnerForLocalOAuthCredential({
      local: requestedProfile,
      main: mainStore?.profiles[params.profileId],
    })
      ? undefined
      : params.agentDir;
  }

  return mainStore?.profiles[params.profileId] ? undefined : params.agentDir;
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

export { hasAnyAuthProfileStoreSource } from "./source-check.js";

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
  loadedAuthStoreCache.clear();
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const payload = buildPersistedAuthProfileSecretsStore(localStore);
  saveJsonFile(authPath, payload);
  savePersistedAuthProfileState(localStore, agentDir);
  writeCachedAuthProfileStore({
    authPath,
    authMtimeMs: readAuthStoreMtimeMs(authPath),
    stateMtimeMs: readAuthStoreMtimeMs(statePath),
    store: localStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    setRuntimeAuthProfileStoreSnapshot(localStore, agentDir);
  }
}
