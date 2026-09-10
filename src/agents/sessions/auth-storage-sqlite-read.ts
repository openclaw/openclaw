/** Read canonical SQLite credentials without turning unreadable state into empty auth. */
import { AUTH_STORE_VERSION } from "../auth-profiles/constants.js";
import { AuthProfileStoreUnreadableError } from "../auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  type AuthProfileDatabase,
} from "../auth-profiles/sqlite.js";
import { loadPersistedAuthProfileState } from "../auth-profiles/state.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

export function loadSqliteAuthStorageStore(
  agentDir: string,
  database?: AuthProfileDatabase,
): AuthProfileStore {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir, database);
  if (inspection.status === "missing") {
    const stateInspection = inspectPersistedAuthProfileStateRaw(agentDir, database);
    if (stateInspection.status === "unreadable") {
      throw new AuthProfileStoreUnreadableError(
        database?.path ?? resolveAuthProfileDatabasePath(agentDir),
      );
    }
    return {
      version: AUTH_STORE_VERSION,
      profiles: {},
      ...loadPersistedAuthProfileState(agentDir, database),
    };
  }
  const store = loadPersistedAuthProfileStore(agentDir, database ? { database } : undefined);
  if (inspection.status === "unreadable" || !store) {
    throw new AuthProfileStoreUnreadableError(
      database?.path ?? resolveAuthProfileDatabasePath(agentDir),
    );
  }
  return store;
}
