import fs from "node:fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveOAuthPath } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";

type LegacyAuthStore = Record<string, AuthProfileCredential>;
type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };
type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
  // Fallback: inherit auth-profiles from main agent if subagent has none.
  // Skipped when skipInheritance:true (e.g. auth-clean pre-lock migration trigger)
  // to prevent materialising main credentials in the subagent file before cleanup
  // runs — that would cause scope bleed and a misleading no-op clean. (#2915653312)
  if (agentDir && !readOnly && !options?.skipInheritance) {
    const mainAuthPath = resolveAuthStorePath(); // without agentDir = main
    const mainRaw = loadJsonFile(mainAuthPath);
    const mainStore = coerceAuthStore(mainRaw);
    if (mainStore && Object.keys(mainStore.profiles).length > 0) {
      // Clone main store to subagent directory for auth inheritance
      saveJsonFile(authPath, mainStore);
      log.info("inherited auth-profiles from main agent", { agentDir });
      return mainStore;
    }
  }

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath(agentDir));
  const legacy = coerceLegacyStore(legacyRaw);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  // Keep external CLI credentials visible in runtime even during read-only loads.
  const syncedCli = syncExternalCliCredentials(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";

  // Legacy migration (auth.json → auth-profiles.json) is suppressed when the
  // caller passes readOnly:true (dry-run or probe-mode loads that must not write).
  // auth-clean.ts probes readOnly:true, then performs a separate readOnly:false
  // load after guards pass to trigger migration before updateAuthProfileStoreWithLock's
  // ensureAuthStoreFile can create an empty placeholder. (#2914491523, #2914711181, #2915530629)
  const shouldMigrateLegacy = !readOnly && !forceReadOnly && legacy !== null;
  // External-CLI / OAuth extras are still suppressed during read-only probes.
  const shouldPersistExtras = !readOnly && !forceReadOnly && (mergedOAuth || syncedCli);

  if (shouldMigrateLegacy || shouldPersistExtras) {
    saveJsonFile(authPath, store);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldMigrateLegacy) {
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
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean; readOnly?: boolean },
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
  const merged = mergeAuthProfileStores(mainStore, store);

  return merged;
}

/**
 * Load only the agent-local auth profile store, without merging with the main
 * agent store. Use this when computing which profiles to delete: the clean
 * command's write target is the agent-local file only, so profile IDs that
 * exist exclusively in the main store must never appear in toRemove.
 *
 * Unlike ensureAuthProfileStore, this function does NOT merge the main store
 * into the result for non-default agents.
 */
export function loadAgentLocalAuthProfileStore(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  return loadAuthProfileStoreForAgent(agentDir, options);
}

export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  const authPath = resolveAuthStorePath(agentDir);
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [profileId, sanitized];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [profileId, sanitized];
      }
      return [profileId, credential];
    }),
  ) as AuthProfileStore["profiles"];
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}
