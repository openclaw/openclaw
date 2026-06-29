/**
 * Auth-profile source probes for runtime and persisted stores.
 * These checks intentionally avoid loading secret-bearing credential payloads.
 */
import fs from "node:fs";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  hasAnyRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import { readPersistedAuthProfileStateRaw, readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

// Auth-profile source checks look at runtime snapshots, JSON compatibility
// files, legacy files, and SQLite stores without materializing secret values.
function hasStoredAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

function readJsonFile(pathname: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function rawStoreHasProviderProfile(raw: unknown, provider: string): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object") {
    return false;
  }
  const expected = normalizeProvider(provider);
  for (const [profileId, rawCredential] of Object.entries(profiles)) {
    if (normalizeProvider(profileId).startsWith(`${expected}:`)) {
      return true;
    }
    if (
      rawCredential &&
      typeof rawCredential === "object" &&
      normalizeProvider(String((rawCredential as { provider?: unknown }).provider ?? "")) ===
        expected
    ) {
      return true;
    }
  }
  return false;
}

function runtimeStoreHasProviderProfile(
  store: AuthProfileStore | undefined,
  provider: string,
): boolean {
  return rawStoreHasProviderProfile(store, provider);
}

/** Returns true when any local/runtime/main auth profile source exists. */
export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasLocalAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }

  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (
    agentDir &&
    authPath !== mainAuthPath &&
    (hasStoredAuthProfileFiles(undefined) ||
      readPersistedAuthProfileStoreRaw(undefined) ||
      readPersistedAuthProfileStateRaw(undefined))
  ) {
    return true;
  }
  return false;
}

/** Returns true when the requested agent dir has a local auth profile source. */
export function hasLocalAuthProfileStoreSource(agentDir?: string): boolean {
  const runtimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (runtimeStore && Object.keys(runtimeStore.profiles).length > 0) {
    return true;
  }
  if (hasStoredAuthProfileFiles(agentDir)) {
    return true;
  }
  return Boolean(
    readPersistedAuthProfileStoreRaw(agentDir) || readPersistedAuthProfileStateRaw(agentDir),
  );
}

/** Returns true when a read-only auth-profile source contains a profile for a provider. */
export function hasAuthProfileStoreSourceForProvider(provider: string, agentDir?: string): boolean {
  if (!normalizeProvider(provider)) {
    return false;
  }
  const localRuntimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (runtimeStoreHasProviderProfile(localRuntimeStore, provider)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readJsonFile(resolveAuthStorePath(agentDir)), provider)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readJsonFile(resolveLegacyAuthStorePath(agentDir)), provider)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readPersistedAuthProfileStoreRaw(agentDir), provider)) {
    return true;
  }

  if (!agentDir) {
    return false;
  }
  const mainRuntimeStore = getRuntimeAuthProfileStoreSnapshot();
  if (runtimeStoreHasProviderProfile(mainRuntimeStore, provider)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readJsonFile(resolveAuthStorePath()), provider)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readJsonFile(resolveLegacyAuthStorePath()), provider)) {
    return true;
  }
  return rawStoreHasProviderProfile(readPersistedAuthProfileStoreRaw(), provider);
}
