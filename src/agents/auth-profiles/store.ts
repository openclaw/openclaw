import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION, EXTERNAL_CLI_SYNC_TTL_MS } from "./constants.js";
import { overlayExternalAuthProfiles, shouldPersistExternalAuthProfile } from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { resolveAuthProfileStoreKey } from "./paths.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStoreEntry,
  loadPersistedAuthProfileStoreEntryFromDatabase,
  loadPersistedAuthProfileStore,
  mergeAuthProfileStores,
  savePersistedAuthProfileSecretsStoreInTransaction,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { savePersistedAuthProfileStateInTransaction } from "./state.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  env?: NodeJS.ProcessEnv;
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
};

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
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
  const storeKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (storeKey === mainStoreKey) {
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
  const mainKey = resolveAuthProfileStoreKey(undefined);
  const requestedKey = resolveAuthProfileStoreKey(agentDir);
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

function readCachedAuthProfileStore(params: {
  storeKey: string;
  authMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.storeKey);
  if (!cached || cached.authMtimeMs !== params.authMtimeMs) {
    return null;
  }
  if (Date.now() - cached.syncedAtMs >= EXTERNAL_CLI_SYNC_TTL_MS) {
    return null;
  }
  return cloneAuthProfileStore(cached.store);
}

function writeCachedAuthProfileStore(params: {
  storeKey: string;
  authMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.storeKey, {
    authMtimeMs: params.authMtimeMs,
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
  env?: NodeJS.ProcessEnv;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  try {
    let savedStore: AuthProfileStore | null = null;
    runOpenClawStateWriteTransaction(
      (database) => {
        // SQLite serializes these updates; always reload inside the write
        // transaction so usage/cooldown/auth refresh updates cannot overwrite
        // fresher state from another process.
        const persisted = loadPersistedAuthProfileStoreEntryFromDatabase(database, params.agentDir);
        const store =
          persisted?.store ??
          ({
            version: AUTH_STORE_VERSION,
            profiles: {},
          } satisfies AuthProfileStore);
        const shouldSave = params.updater(store);
        savedStore = store;
        if (shouldSave) {
          saveAuthProfileStoreInTransaction(database, store, params.agentDir);
        }
      },
      { env: params.env },
    );
    if (savedStore) {
      refreshAuthProfileStoreCache(savedStore, params.agentDir, { env: params.env });
    }
    return savedStore;
  } catch {
    return null;
  }
}

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore(undefined, {
    rewriteInlineOAuthSecrets: process.env.OPENCLAW_AUTH_STORE_READONLY !== "1",
  });
  if (asStore) {
    return overlayExternalAuthProfiles(asStore);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  return overlayExternalAuthProfiles(store);
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const persisted = loadPersistedAuthProfileStoreEntry(agentDir, { env: options?.env });
  const authMtimeMs = persisted?.updatedAt ?? null;
  if (!readOnly) {
    const cached = readCachedAuthProfileStore({
      storeKey,
      authMtimeMs,
    });
    if (cached) {
      return cached;
    }
  }
  const asStore = persisted?.store ?? null;
  if (asStore) {
    if (!readOnly) {
      writeCachedAuthProfileStore({
        storeKey,
        authMtimeMs,
        store: asStore,
      });
    }
    return asStore;
  }

  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };

  if (!readOnly) {
    writeCachedAuthProfileStore({
      storeKey,
      authMtimeMs,
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
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || storeKey === mainStoreKey) {
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

export function loadAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: Pick<LoadAuthProfileStoreOptions, "env">,
): AuthProfileStore {
  const loadOptions: LoadAuthProfileStoreOptions = {
    readOnly: true,
    allowKeychainPrompt: false,
    ...(options?.env ? { env: options.env } : {}),
  };
  const store = loadAuthProfileStoreForAgent(agentDir, loadOptions);
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (!agentDir || storeKey === mainStoreKey) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, loadOptions);
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
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (!agentDir || storeKey === mainStoreKey) {
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

  const requestedKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainKey = resolveAuthProfileStoreKey();
  if (requestedKey === mainKey) {
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
  const requestedKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainKey = resolveAuthProfileStoreKey();
  if (requestedKey === mainKey) {
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
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (!agentDir || storeKey === mainStoreKey) {
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
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  runOpenClawStateWriteTransaction(
    (database) => {
      saveAuthProfileStoreInTransaction(database, localStore, agentDir);
    },
    { env: options?.env },
  );
  refreshAuthProfileStoreCache(localStore, agentDir, { env: options?.env });
}

function saveAuthProfileStoreInTransaction(
  database: OpenClawStateDatabase,
  localStore: AuthProfileStore,
  agentDir?: string,
): void {
  const updatedAt = Date.now();
  const payload = buildPersistedAuthProfileSecretsStore(localStore);
  savePersistedAuthProfileSecretsStoreInTransaction(database, payload, agentDir, updatedAt);
  savePersistedAuthProfileStateInTransaction(database, localStore, agentDir, updatedAt);
}

function refreshAuthProfileStoreCache(
  store: AuthProfileStore,
  agentDir?: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const persisted = loadPersistedAuthProfileStoreEntry(agentDir, options);
  writeCachedAuthProfileStore({
    storeKey,
    authMtimeMs: persisted?.updatedAt ?? null,
    store,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
  }
}
