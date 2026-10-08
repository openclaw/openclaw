import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { prepareSqliteReadCache } from "../../infra/sqlite-read-cache.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadDatabase,
  closeAuthProfileReadPool,
} from "./sqlite-read-pool.js";
import { recordAuthProfileNativeCommit } from "./store-update-commit.js";
import type { AuthProfileRowRead, PersistedAuthProfileStoreInspection } from "./types.js";

type AgentAuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthProfileDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
const PRIMARY_ROW_KEY = "primary";
const AGENT_AUTH_CELLS = {
  store: { table: "auth_profile_store", key: "store_key", value: "store_json" },
  state: { table: "auth_profile_state", key: "state_key", value: "state_json" },
} as const;
// Shared-state auth payloads live in config_machine_state; the keys are listed
// in STATE_SECRET_CONFIG_STATE_KEY_PREFIXES so git backups never carry them.
const SHARED_AUTH_CELL_KEYS = { store: "authProfiles.store", state: "authProfiles.state" };
export const SHARED_AUTH_STORE_STATE_KEY = "auth.sharedStore";

function inspectAuthProfileTable(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection | null {
  const tableName =
    databaseKind === "shared-state" ? "config_machine_state" : AGENT_AUTH_CELLS[target].table;
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

/** Read admitted auth cells without discarding malformed JSON needed for migration backups. */
export function readAuthProfileJsonCellText(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): string | undefined {
  if (databaseKind === "shared-state") {
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<SharedAuthProfileDatabase>(db)
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", SHARED_AUTH_CELL_KEYS[target]),
    )?.value_json;
  }
  const cell = AGENT_AUTH_CELLS[target];
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AgentAuthProfileDatabase>(db)
      .selectFrom(cell.table)
      .select(cell.value)
      .where(cell.key, "=", PRIMARY_ROW_KEY),
  )?.[cell.value];
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
  const raw = readAuthProfileJsonCellText(db, target, databaseKind);
  if (raw === undefined) {
    return { status: "missing", reason: "row" };
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
  const inspect = (target: "store" | "state"): PersistedAuthProfileStoreInspection => {
    try {
      return inspectAuthProfileJsonCell(database, target, databaseKind);
    } catch (error) {
      // Shared-state read ownership handles native failures and poisoned-handle eviction.
      if (databaseKind === "shared-state") {
        throw error;
      }
      // A broken state table must not turn an absent credential row into a present source.
      return { status: "unreadable" };
    }
  };
  const store = inspect("store");
  const state = inspect("state");
  return {
    store,
    state,
    cacheable: store.status !== "unreadable" && state.status !== "unreadable" && canCache(),
  };
}

/** Write one canonical auth cell on the caller's admitted transaction connection. */
export function writeAuthProfileJsonCell(
  database: DatabaseSync,
  target: "store" | "state",
  kind: "agent" | "shared-state",
  payload: unknown,
): void {
  recordAuthProfileNativeCommit(database);
  const value = JSON.stringify(payload);
  const now = Date.now();
  const query =
    kind === "shared-state"
      ? getNodeSqliteKysely<SharedAuthProfileDatabase>(database)
          .insertInto("config_machine_state")
          .values({
            state_key: SHARED_AUTH_CELL_KEYS[target],
            value_json: value,
            updated_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.column("state_key").doUpdateSet({ value_json: value, updated_at_ms: now }),
          )
      : target === "store"
        ? getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
            .insertInto("auth_profile_store")
            .values({ store_key: PRIMARY_ROW_KEY, store_json: value, updated_at: now })
            .onConflict((conflict) =>
              conflict.column("store_key").doUpdateSet({ store_json: value, updated_at: now }),
            )
        : getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
            .insertInto("auth_profile_state")
            .values({ state_key: PRIMARY_ROW_KEY, state_json: value, updated_at: now })
            .onConflict((conflict) =>
              conflict.column("state_key").doUpdateSet({ state_json: value, updated_at: now }),
            );
  executeSqliteQuerySync(database, query);
}

export function deleteAuthProfileJsonCell(
  database: DatabaseSync,
  target: "store" | "state",
  kind: "agent" | "shared-state",
): void {
  recordAuthProfileNativeCommit(database);
  const cell = AGENT_AUTH_CELLS[target];
  const query =
    kind === "shared-state"
      ? getNodeSqliteKysely<SharedAuthProfileDatabase>(database)
          .deleteFrom("config_machine_state")
          .where("state_key", "=", SHARED_AUTH_CELL_KEYS[target])
      : getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
          .deleteFrom(cell.table)
          .where(cell.key, "=", PRIMARY_ROW_KEY);
  executeSqliteQuerySync(database, query);
}
