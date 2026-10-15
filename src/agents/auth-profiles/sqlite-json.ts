import { executeWithCachedStatement } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { prepareSqliteReadCache } from "../../infra/sqlite-read-cache.js";
import type { SqliteAuthSchema } from "../../infra/sqlite-readonly-auth-schema.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadDatabase,
  type AuthProfileReadDatabaseOpener,
} from "./sqlite-read-pool.js";
import type { AuthProfileRowRead, PersistedAuthProfileStoreInspection } from "./types.js";

export type AgentAuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
export type SharedAuthProfileDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
export const AUTH_PROFILE_PRIMARY_ROW_KEY = "primary";
export const AGENT_AUTH_CELLS = {
  store: { table: "auth_profile_store", key: "store_key", value: "store_json" },
  state: { table: "auth_profile_state", key: "state_key", value: "state_json" },
} as const;
// Shared-state auth payloads live in config_machine_state; the keys are listed
// in STATE_SECRET_CONFIG_STATE_KEY_PREFIXES so git backups never carry them.
export const SHARED_AUTH_CELL_KEYS = { store: "authProfiles.store", state: "authProfiles.state" };
export const SHARED_AUTH_STORE_STATE_KEY = "auth.sharedStore";

function authProfileTableName(
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): string {
  return databaseKind === "shared-state" ? "config_machine_state" : AGENT_AUTH_CELLS[target].table;
}

function inspectAuthProfileTableType(type: unknown): PersistedAuthProfileStoreInspection | null {
  if (type === undefined) {
    // Older agent databases acquire the additive auth tables on writable bootstrap.
    return { status: "missing", reason: "table" };
  }
  return type === "table" ? null : { status: "unreadable" };
}

function authProfileSchemaObjectType(schema: SqliteSchemaFacts, name: string): string | undefined {
  if (schema.tables.has(name)) {
    return "table";
  }
  return schema.views.has(name) || schema.indexes.has(name) || schema.triggers.has(name)
    ? "other"
    : undefined;
}

function inspectAuthProfileTable(
  db: EngineConnection,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection | null {
  const tableName = authProfileTableName(target, databaseKind);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return inspectAuthProfileTableType(authProfileSchemaObjectType(schema, tableName));
  }
  const schemaObject = executeWithCachedStatement(
    db,
    "SELECT type FROM sqlite_master WHERE name = ?",
    [tableName],
    (statement) => statement.get(tableName),
  );
  return inspectAuthProfileTableType(schemaObject?.type);
}

/** Read admitted auth cells without discarding malformed JSON needed for migration backups. */
export function readAuthProfileJsonCellText(
  db: EngineConnection,
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
      .where(cell.key, "=", AUTH_PROFILE_PRIMARY_ROW_KEY),
  )?.[cell.value];
}

export function inspectAuthProfileJsonCell(
  db: EngineConnection,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection {
  const tableInspection = inspectAuthProfileTable(db, target, databaseKind);
  if (tableInspection) {
    return tableInspection;
  }
  return inspectAuthProfileJsonCellContents(db, target, databaseKind);
}

function inspectAuthProfileJsonCellContents(
  db: EngineConnection,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection {
  return inspectAuthProfileJsonText(readAuthProfileJsonCellText(db, target, databaseKind));
}

function inspectAuthProfileJsonText(raw: string | undefined): PersistedAuthProfileStoreInspection {
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
  openReadOnlyDatabase: AuthProfileReadDatabaseOpener,
): PersistedAuthProfileStoreInspection {
  const acquired = acquireAuthProfileReadDatabase(databasePath, openReadOnlyDatabase);
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

/** Reuse the worker-owned reader; each statement observes the latest committed rows. */
export function readAuthProfileRowsReadOnly(
  databasePath: string,
  openReadOnlyDatabase: AuthProfileReadDatabaseOpener,
  schema?: SqliteAuthSchema,
  expectedIdentity?: string,
  retainReader = true,
): AuthProfileRowRead {
  const acquired = acquireAuthProfileReadDatabase(
    databasePath,
    openReadOnlyDatabase,
    schema,
    expectedIdentity,
  );
  if (acquired.status !== "readable") {
    const inspection: PersistedAuthProfileStoreInspection =
      acquired.status === "missing"
        ? { status: "missing", reason: "database" }
        : { status: "unreadable" };
    return { store: inspection, state: inspection, cacheable: false };
  }
  let keepReader = retainReader;
  try {
    const rows = readAuthProfileRows(acquired.db, databasePath, "agent", schema);
    // Another process initializes new agent files; empty schema facts cannot stay pooled.
    if (
      rows.store.status === "missing" &&
      rows.store.reason === "table" &&
      rows.state.status === "missing" &&
      rows.state.reason === "table"
    ) {
      keepReader = false;
    }
    return rows;
  } catch {
    closeAuthProfileReadDatabase(databasePath);
    return { store: { status: "unreadable" }, state: { status: "unreadable" }, cacheable: false };
  } finally {
    if (isArtifactPreservingStateRead("agent", databasePath)) {
      acquired.db.close();
    } else if (!keepReader) {
      closeAuthProfileReadDatabase(databasePath);
    }
  }
}

/** Worker reads acquire both cells in one SQLite snapshot. */
export function readAuthProfileRows(
  database: EngineConnection,
  databasePath: string,
  databaseKind: "agent" | "shared-state",
  authSchema?: SqliteAuthSchema,
): AuthProfileRowRead {
  const canCache = isPostgresSqlConnection(database)
    ? () => false
    : prepareSqliteReadCache(database, databasePath);
  const storeTable = authProfileTableName("store", databaseKind);
  const stateTable = authProfileTableName("state", databaseKind);
  let schemaObjects: Array<Record<string, unknown>>;
  try {
    const schema = authSchema ? undefined : getAdmittedSqliteSchemaFacts(database);
    if (authSchema) {
      schemaObjects = [
        { name: storeTable, type: authSchema.store === "missing" ? undefined : authSchema.store },
        { name: stateTable, type: authSchema.state === "missing" ? undefined : authSchema.state },
      ];
    } else if (schema) {
      schemaObjects = [storeTable, stateTable].map((name) => ({
        name,
        type: authProfileSchemaObjectType(schema, name),
      }));
    } else {
      // Legacy and authorizer-controlled readers still classify both tables natively.
      schemaObjects = executeWithCachedStatement(
        database,
        "SELECT name, type FROM sqlite_master WHERE name IN (?, ?)",
        [storeTable, stateTable],
        (statement) => statement.all(storeTable, stateTable),
      );
    }
  } catch (error) {
    if (databaseKind === "shared-state") {
      throw error;
    }
    return { store: { status: "unreadable" }, state: { status: "unreadable" }, cacheable: false };
  }
  const inspect = (target: "store" | "state"): PersistedAuthProfileStoreInspection => {
    const tableName = target === "store" ? storeTable : stateTable;
    const tableInspection = inspectAuthProfileTableType(
      schemaObjects.find((row) => row.name === tableName)?.type,
    );
    if (tableInspection) {
      return tableInspection;
    }
    try {
      return inspectAuthProfileJsonCellContents(database, target, databaseKind);
    } catch (error) {
      // Shared-state read ownership handles native failures and poisoned-handle eviction.
      if (databaseKind === "shared-state") {
        throw error;
      }
      // A broken state table must not turn an absent credential row into a present source.
      return { status: "unreadable" };
    }
  };
  let store: PersistedAuthProfileStoreInspection;
  let state: PersistedAuthProfileStoreInspection;
  const hasBothTables = [storeTable, stateTable].every((name) =>
    schemaObjects.some((row) => row.name === name && row.type === "table"),
  );
  if (hasBothTables) {
    try {
      const rows =
        databaseKind === "shared-state"
          ? executeSqliteQuerySync(
              database,
              getNodeSqliteKysely<SharedAuthProfileDatabase>(database)
                .selectFrom("config_machine_state")
                .select(["state_key as target", "value_json as contents"])
                .where("state_key", "in", [
                  SHARED_AUTH_CELL_KEYS.store,
                  SHARED_AUTH_CELL_KEYS.state,
                ]),
            ).rows
          : executeSqliteQuerySync(
              database,
              getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
                .selectFrom("auth_profile_store")
                .select("store_json as contents")
                .select((expression) => expression.val("store").as("target"))
                .where("store_key", "=", AUTH_PROFILE_PRIMARY_ROW_KEY)
                .unionAll(
                  getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
                    .selectFrom("auth_profile_state")
                    .select("state_json as contents")
                    .select((expression) => expression.val("state").as("target"))
                    .where("state_key", "=", AUTH_PROFILE_PRIMARY_ROW_KEY),
                ),
            ).rows;
      const texts = new Map(rows.map((row) => [row.target, row.contents]));
      store = inspectAuthProfileJsonText(
        texts.get(databaseKind === "shared-state" ? SHARED_AUTH_CELL_KEYS.store : "store"),
      );
      state = inspectAuthProfileJsonText(
        texts.get(databaseKind === "shared-state" ? SHARED_AUTH_CELL_KEYS.state : "state"),
      );
    } catch (error) {
      if (databaseKind === "shared-state") {
        throw error;
      }
      // A damaged legacy table must not hide the other cell's independent presence.
      store = inspect("store");
      state = inspect("state");
    }
  } else {
    store = inspect("store");
    state = inspect("state");
  }
  return {
    store,
    state,
    cacheable: store.status !== "unreadable" && state.status !== "unreadable" && canCache(),
  };
}

function inspectAuthProfileRow(
  database: EngineConnection,
  target: "store" | "state",
  databaseKind: "agent" | "shared-state",
): PersistedAuthProfileStoreInspection {
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
}

/** The selected worker returns source presence without transferring credential rows. */
export function hasAgentAuthProfileSourceInDatabase(database: EngineConnection): boolean {
  const store = inspectAuthProfileRow(database, "store", "agent");
  if (store.status !== "missing") {
    return true;
  }
  const state = inspectAuthProfileRow(database, "state", "agent");
  return state.status === "readable" && Boolean(state.raw);
}
