import fs from "node:fs";
import { appendAgentExecDebug } from "../../cli/agent-exec-debug.js";
import { withFileLock } from "../../infra/file-lock.js";
import { saveJsonFile } from "../../infra/json-file.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  AUTH_STORE_VERSION,
  EXTERNAL_CLI_SYNC_TTL_MS,
  log,
} from "./constants.js";
import { overlayExternalAuthProfiles, shouldPersistExternalAuthProfile } from "./external-auth.js";
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
  readOnly?: boolean;
  syncExternalCli?: boolean;
  commandName?: string;
  effectiveToolPolicy?: string;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
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

function appendAuthProfileStoreDebug(
  event:
    | "authProfileStore_loadAuthProfileStore_enter"
    | "authProfileStore_loadAuthProfileStoreForRuntime_enter"
    | "authProfileStore_ensureAuthProfileStore_enter"
    | "authProfileStore_saveAuthProfileStore_enter"
    | "authProfileStore_before_overlayExternalAuthProfiles"
    | "authProfileStore_before_shouldPersistExternalAuthProfile",
  params: {
    auth_profile_store_branch: string;
    raw_commandName?: string;
    raw_effectiveToolPolicy?: string;
    calls_overlayExternalAuthProfiles: boolean;
    calls_shouldPersistExternalAuthProfile: boolean;
    passes_commandName: boolean;
    passes_effectiveToolPolicy: boolean;
  },
): void {
  appendAgentExecDebug("auth-profile-store", event, params);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
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
    return requestedStore;
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

export function loadAuthProfileStore(
  options?: Pick<LoadAuthProfileStoreOptions, "commandName" | "effectiveToolPolicy">,
): AuthProfileStore {
  appendAuthProfileStoreDebug("authProfileStore_loadAuthProfileStore_enter", {
    auth_profile_store_branch: "loadAuthProfileStore",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
      auth_profile_store_branch: "loadAuthProfileStore",
      raw_commandName: options?.commandName,
      raw_effectiveToolPolicy: options?.effectiveToolPolicy,
      calls_overlayExternalAuthProfiles: true,
      calls_shouldPersistExternalAuthProfile: false,
      passes_commandName:
        typeof options?.commandName === "string" && options.commandName.trim().length > 0,
      passes_effectiveToolPolicy:
        typeof options?.effectiveToolPolicy === "string" &&
        options.effectiveToolPolicy.trim().length > 0,
    });
    return overlayExternalAuthProfiles(asStore, {
      commandName: options?.commandName,
      effectiveToolPolicy: options?.effectiveToolPolicy,
    });
  }
  const legacy = loadLegacyAuthProfileStore();
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyAuthStore(store, legacy);
    appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
      auth_profile_store_branch: "loadAuthProfileStore",
      raw_commandName: options?.commandName,
      raw_effectiveToolPolicy: options?.effectiveToolPolicy,
      calls_overlayExternalAuthProfiles: true,
      calls_shouldPersistExternalAuthProfile: false,
      passes_commandName:
        typeof options?.commandName === "string" && options.commandName.trim().length > 0,
      passes_effectiveToolPolicy:
        typeof options?.effectiveToolPolicy === "string" &&
        options.effectiveToolPolicy.trim().length > 0,
    });
    return overlayExternalAuthProfiles(store, {
      commandName: options?.commandName,
      effectiveToolPolicy: options?.effectiveToolPolicy,
    });
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
    auth_profile_store_branch: "loadAuthProfileStore",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  return overlayExternalAuthProfiles(store, {
    commandName: options?.commandName,
    effectiveToolPolicy: options?.effectiveToolPolicy,
  });
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
  appendAuthProfileStoreDebug("authProfileStore_loadAuthProfileStoreForRuntime_enter", {
    auth_profile_store_branch: "loadAuthProfileStoreForRuntime",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
      auth_profile_store_branch: "loadAuthProfileStoreForRuntime",
      raw_commandName: options?.commandName,
      raw_effectiveToolPolicy: options?.effectiveToolPolicy,
      calls_overlayExternalAuthProfiles: true,
      calls_shouldPersistExternalAuthProfile: false,
      passes_commandName:
        typeof options?.commandName === "string" && options.commandName.trim().length > 0,
      passes_effectiveToolPolicy:
        typeof options?.effectiveToolPolicy === "string" &&
        options.effectiveToolPolicy.trim().length > 0,
    });
    return overlayExternalAuthProfiles(store, {
      agentDir,
      commandName: options?.commandName,
      effectiveToolPolicy: options?.effectiveToolPolicy,
    });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
    auth_profile_store_branch: "loadAuthProfileStoreForRuntime",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  return overlayExternalAuthProfiles(mergeAuthProfileStores(mainStore, store), {
    agentDir,
    commandName: options?.commandName,
    effectiveToolPolicy: options?.effectiveToolPolicy,
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
    commandName?: string;
    effectiveToolPolicy?: string;
  },
): AuthProfileStore {
  appendAuthProfileStoreDebug("authProfileStore_ensureAuthProfileStore_enter", {
    auth_profile_store_branch: "ensureAuthProfileStore",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
      auth_profile_store_branch: "ensureAuthProfileStore",
      raw_commandName: options?.commandName,
      raw_effectiveToolPolicy: options?.effectiveToolPolicy,
      calls_overlayExternalAuthProfiles: true,
      calls_shouldPersistExternalAuthProfile: false,
      passes_commandName:
        typeof options?.commandName === "string" && options.commandName.trim().length > 0,
      passes_effectiveToolPolicy:
        typeof options?.effectiveToolPolicy === "string" &&
        options.effectiveToolPolicy.trim().length > 0,
    });
    return overlayExternalAuthProfiles(runtimeStore, {
      agentDir,
      commandName: options?.commandName,
      effectiveToolPolicy: options?.effectiveToolPolicy,
    });
  }

  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
      auth_profile_store_branch: "ensureAuthProfileStore",
      raw_commandName: options?.commandName,
      raw_effectiveToolPolicy: options?.effectiveToolPolicy,
      calls_overlayExternalAuthProfiles: true,
      calls_shouldPersistExternalAuthProfile: false,
      passes_commandName:
        typeof options?.commandName === "string" && options.commandName.trim().length > 0,
      passes_effectiveToolPolicy:
        typeof options?.effectiveToolPolicy === "string" &&
        options.effectiveToolPolicy.trim().length > 0,
    });
    return overlayExternalAuthProfiles(store, {
      agentDir,
      commandName: options?.commandName,
      effectiveToolPolicy: options?.effectiveToolPolicy,
    });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const merged = mergeAuthProfileStores(mainStore, store);

  appendAuthProfileStoreDebug("authProfileStore_before_overlayExternalAuthProfiles", {
    auth_profile_store_branch: "ensureAuthProfileStore",
    raw_commandName: options?.commandName,
    raw_effectiveToolPolicy: options?.effectiveToolPolicy,
    calls_overlayExternalAuthProfiles: true,
    calls_shouldPersistExternalAuthProfile: false,
    passes_commandName:
      typeof options?.commandName === "string" && options.commandName.trim().length > 0,
    passes_effectiveToolPolicy:
      typeof options?.effectiveToolPolicy === "string" &&
      options.effectiveToolPolicy.trim().length > 0,
  });
  return overlayExternalAuthProfiles(merged, {
    agentDir,
    commandName: options?.commandName,
    effectiveToolPolicy: options?.effectiveToolPolicy,
  });
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
  appendAuthProfileStoreDebug("authProfileStore_saveAuthProfileStore_enter", {
    auth_profile_store_branch: "saveAuthProfileStore",
    raw_commandName: undefined,
    raw_effectiveToolPolicy: undefined,
    calls_overlayExternalAuthProfiles: false,
    calls_shouldPersistExternalAuthProfile: true,
    passes_commandName: false,
    passes_effectiveToolPolicy: false,
  });
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const payload = buildPersistedAuthProfileSecretsStore(store, ({ profileId, credential }) => {
    if (credential.type !== "oauth") {
      return true;
    }
    if (options?.filterExternalAuthProfiles === false) {
      return true;
    }
    appendAuthProfileStoreDebug("authProfileStore_before_shouldPersistExternalAuthProfile", {
      auth_profile_store_branch: "saveAuthProfileStore",
      raw_commandName: undefined,
      raw_effectiveToolPolicy: undefined,
      calls_overlayExternalAuthProfiles: false,
      calls_shouldPersistExternalAuthProfile: true,
      passes_commandName: false,
      passes_effectiveToolPolicy: false,
    });
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
  writeCachedAuthProfileStore({
    authPath,
    authMtimeMs: readAuthStoreMtimeMs(authPath),
    stateMtimeMs: readAuthStoreMtimeMs(statePath),
    store: runtimeStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    setRuntimeAuthProfileStoreSnapshot(runtimeStore, agentDir);
  }
}
