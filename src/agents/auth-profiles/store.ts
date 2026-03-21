import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveOAuthPath } from "../../config/paths.js";
import { loadJsonFile } from "../../infra/json-file.js";
import {
  loadAuthProfileStoreFromDb,
  saveAuthProfileStoreToDb,
  updateAuthProfileStoreInDb,
} from "./auth-profiles-sqlite.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";

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
import { resolveAuthStorePath } from "./paths.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
};

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  if (runtimeAuthStoreSnapshots.size === 0) {
    return null;
  }

  const mainKey = resolveRuntimeStoreKey(undefined);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
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
  if (mainStore) {
    return cloneAuthProfileStore(mainStore);
  }

  return null;
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  try {
    return updateAuthProfileStoreInDb(params.updater);
  } catch {
    return null;
  }
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return base;
  }
  return {
    version: Math.max(base.version, override.version ?? base.version),
    profiles: { ...base.profiles, ...override.profiles },
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") {
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") {
      continue;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

export function loadAuthProfileStore(): AuthProfileStore {
  const fromDb = loadAuthProfileStoreFromDb();
  const store = fromDb ?? { version: AUTH_STORE_VERSION, profiles: {} };
  const synced = syncExternalCliCredentialsTimed(store);
  if (synced && Object.keys(store.profiles).length > 0) {
    saveAuthProfileStoreToDb(store);
  }
  return store;
}

function loadAuthProfileStoreForAgent(
  _agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const fromDb = loadAuthProfileStoreFromDb();
  const store = fromDb ?? { version: AUTH_STORE_VERSION, profiles: {} };
  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const syncedCli = syncExternalCliCredentialsTimed(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  if (!readOnly && !forceReadOnly && (mergedOAuth || syncedCli)) {
    saveAuthProfileStoreToDb(store);
  }
  return store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  return loadAuthProfileStoreForAgent(agentDir, options);
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
    return runtimeStore;
  }
  return loadAuthProfileStoreForAgent(agentDir, options);
}

export function saveAuthProfileStore(store: AuthProfileStore, _agentDir?: string): void {
  // Strip plaintext secrets when keyRef/tokenRef is present
  const stripped: Record<string, AuthProfileCredential> = {};
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
      const sanitized = { ...credential } as Record<string, unknown>;
      delete sanitized.key;
      stripped[profileId] = sanitized as AuthProfileCredential;
    } else if (
      credential.type === "token" &&
      credential.tokenRef &&
      credential.token !== undefined
    ) {
      const sanitized = { ...credential } as Record<string, unknown>;
      delete sanitized.token;
      stripped[profileId] = sanitized as AuthProfileCredential;
    } else {
      stripped[profileId] = credential;
    }
  }
  const payload: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: stripped,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  };
  saveAuthProfileStoreToDb(payload);
}
