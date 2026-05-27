import { cloneAuthProfileStore } from "./clone.js";
import { EXTERNAL_CLI_SYNC_TTL_MS } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();

/**
 * Read a cached auth profile store entry.
 *
 * `cacheKey` is an opaque, option-sensitive key built by the caller (typically a
 * stable JSON serialization of authPath + load-options). Keying by authPath alone
 * caused option-set poisoning: a caller asking for read-only / no-external-cli
 * sync could observe a store cached by a caller that did sync external CLI
 * profiles, and vice versa.
 */
export function readCachedAuthProfileStore(params: {
  cacheKey: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.cacheKey);
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

export function writeCachedAuthProfileStore(params: {
  cacheKey: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.cacheKey, {
    authMtimeMs: params.authMtimeMs,
    stateMtimeMs: params.stateMtimeMs,
    syncedAtMs: Date.now(),
    store: cloneAuthProfileStore(params.store),
  });
}

export function clearLoadedAuthStoreCache(): void {
  loadedAuthStoreCache.clear();
}
