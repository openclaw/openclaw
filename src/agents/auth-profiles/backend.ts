import type { AuthProfileStore } from "./types.js";

/**
 * Backend abstraction for auth profile storage.
 *
 * Implementations handle persistence (file-based, database-based, etc.)
 * while consumers continue using the same AuthProfileStore shape.
 */
export interface AuthStoreBackend {
  /**
   * Load the auth profile store, optionally scoped to an agent directory.
   * For centralized backends (DB), agentDir may be ignored since all agents
   * share a single store.
   */
  load(agentDir?: string, options?: { allowKeychainPrompt?: boolean }): AuthProfileStore;

  /**
   * Persist the auth profile store.
   * For centralized backends, agentDir may be ignored.
   */
  save(store: AuthProfileStore, agentDir?: string): void;

  /**
   * Atomic read-modify-write with locking.
   * The updater receives the latest store and returns true if changes should be saved.
   * Returns the (possibly updated) store, or null if locking failed.
   */
  loadWithLock(params: {
    agentDir?: string;
    updater: (store: AuthProfileStore) => boolean;
  }): Promise<AuthProfileStore | null>;
}
