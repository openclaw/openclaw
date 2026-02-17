import {
  FileAuthStoreBackend,
  loadAuthProfileStore as fileLoadAuthProfileStore,
} from "./backend-file.js";
import type { AuthStoreBackend } from "./backend.js";
import type { AuthProfileStore } from "./types.js";

// ---------------------------------------------------------------------------
// Backend singleton — default to file-based, swappable at runtime
// ---------------------------------------------------------------------------

let backend: AuthStoreBackend = new FileAuthStoreBackend();

/**
 * Replace the auth store backend at runtime.
 * Used to swap from file-based to DB-based when AUTH_ENCRYPTION_KEY is set.
 */
export function setAuthStoreBackend(newBackend: AuthStoreBackend): void {
  backend = newBackend;
}

/**
 * Get the current auth store backend (for testing/inspection).
 */
export function getAuthStoreBackend(): AuthStoreBackend {
  return backend;
}

// ---------------------------------------------------------------------------
// Sync helper (used by _syncAuthProfileStore callers)
// ---------------------------------------------------------------------------

export function _syncAuthProfileStore(target: AuthProfileStore, source: AuthProfileStore): void {
  target.version = source.version;
  target.profiles = source.profiles;
  target.order = source.order;
  target.lastGood = source.lastGood;
  target.usageStats = source.usageStats;
}

// ---------------------------------------------------------------------------
// Public API — delegates to the active backend
// ---------------------------------------------------------------------------

export function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  return backend.loadWithLock(params);
}

/**
 * Load the main auth profile store (no agent scoping).
 * Preserved for backwards compatibility with consumers that import this directly.
 */
export function loadAuthProfileStore(): AuthProfileStore {
  return fileLoadAuthProfileStore();
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  return backend.load(agentDir, options);
}

export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  backend.save(store, agentDir);
}
