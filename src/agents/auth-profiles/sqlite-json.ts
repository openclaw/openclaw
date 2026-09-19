import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "../../infra/kysely-sync-cache-state.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { prepareSqliteReadCache } from "../../infra/sqlite-read-cache.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadDatabase,
  closeAuthProfileReadPool,
} from "./sqlite-read-pool.js";
import type { AuthProfileRowRead, PersistedAuthProfileStoreInspection } from "./types.js";

type AgentAuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthProfileDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
export const PRIMARY_ROW_KEY = "primary";
// Shared-state auth payloads live in config_machine_state; the keys are listed
// in STATE_SECRET_CONFIG_STATE_KEY_PREFIXES so git backups never carry them.
export const SHARED_STORE_STATE_KEY = "authProfiles.store";
export const SHARED_STATE_STATE_KEY = "authProfiles.state";
export const SHARED_AUTH_STORE_STATE_KEY = "auth.sharedStore";

// Callers own transactions; opening another here would nest.
export function readSharedAuthKvCell(db: DatabaseSync, stateKey: string): string | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSharedAuthProfileKysely(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", stateKey),
  );
  return row?.value_json;
}

export function getAgentAuthProfileKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AgentAuthProfileDatabase>(db);
}

export function getSharedAuthProfileKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SharedAuthProfileDatabase>(db);
}

function inspectAuthProfileTable(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection | null {
  const tableName =
    databaseKind === "shared-state"
      ? "config_machine_state"
      : target === "store"
        ? "auth_profile_store"
        : "auth_profile_state";
  const schemaObject = executeWithCachedStatement(
    db,
    "SELECT type FROM sqlite_master WHERE name = ?",
    [tableName],
    (statement) => statement.get(tableName),
  );
  if (!schemaObject) {
    // Agent databases shipped before SQLite auth storage do not have these
    // additive tables until their next writable bootstrap.
    return { status: "missing", reason: "table" };
  }
  return schemaObject.type === "table" ? null : { status: "unreadable" };
}

export function inspectAuthProfileJsonCell(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection {
  const tableInspection = inspectAuthProfileTable(db, target, databaseKind);
  if (tableInspection) {
    return tableInspection;
  }
  let raw: string;
  if (databaseKind === "shared-state") {
    const cell = readSharedAuthKvCell(
      db,
      target === "store" ? SHARED_STORE_STATE_KEY : SHARED_STATE_STATE_KEY,
    );
    if (cell === undefined) {
      return { status: "missing", reason: "row" };
    }
    raw = cell;
  } else if (target === "store") {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getAgentAuthProfileKysely(db)
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.store_json;
  } else {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getAgentAuthProfileKysely(db)
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.state_json;
  }
  try {
    return { status: "readable", raw: JSON.parse(raw) as unknown };
  } catch {
    return { status: "unreadable" };
  }
}

export function inspectAgentAuthProfileJsonCellReadOnly(
  databasePath: string,
  target: "store" | "state",
): PersistedAuthProfileStoreInspection {
  const acquired = acquireAuthProfileReadDatabase(databasePath);
  if (acquired.status === "missing") {
    return { status: "missing", reason: "database" };
  }
  if (acquired.status === "unreadable") {
    return { status: "unreadable" };
  }
  try {
    return inspectAuthProfileJsonCell(acquired.db, target, "agent");
  } catch {
    closeAuthProfileReadDatabase(databasePath);
    return { status: "unreadable" };
  }
}

/** The isolated reader closes its native pool before transferring credential rows. */
export function readAuthProfileRowsReadOnly(databasePath: string): AuthProfileRowRead {
  try {
    const acquired = acquireAuthProfileReadDatabase(databasePath);
    if (acquired.status !== "readable") {
      const inspection: PersistedAuthProfileStoreInspection =
        acquired.status === "missing"
          ? { status: "missing", reason: "database" }
          : { status: "unreadable" };
      return { store: inspection, state: inspection, cacheable: false };
    }
    try {
      return readAuthProfileRows(acquired.db, databasePath, "agent");
    } catch {
      return { store: { status: "unreadable" }, state: { status: "unreadable" }, cacheable: false };
    }
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
}

/** Shared and agent rows use one connection for their committed-generation proof. */
export function readAuthProfileRows(
  database: DatabaseSync,
  databasePath: string,
  databaseKind: "agent" | "shared-state",
): AuthProfileRowRead {
  const canCache = prepareSqliteReadCache(database, databasePath);
  const store = inspectAuthProfileJsonCell(database, "store", databaseKind);
  const state = inspectAuthProfileJsonCell(database, "state", databaseKind);
  return {
    store,
    state,
    cacheable: store.status !== "unreadable" && state.status !== "unreadable" && canCache(),
  };
}
