import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

export type AuthProfilePayloadValue =
  | null
  | boolean
  | number
  | string
  | AuthProfilePayloadValue[]
  | { [key: string]: AuthProfilePayloadValue };

export type AuthProfilePayloadReadResult =
  | { exists: false }
  | { exists: true; value: AuthProfilePayloadValue | undefined; updatedAt: number };

type AuthProfileStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "auth_profile_stores" | "auth_profile_state"
>;

type AuthProfileStoreInsert = Insertable<AuthProfileStoreDatabase["auth_profile_stores"]>;
type AuthProfileStateInsert = Insertable<AuthProfileStoreDatabase["auth_profile_state"]>;
type AuthProfileStoreRow = Selectable<AuthProfileStoreDatabase["auth_profile_stores"]>;
type AuthProfileStateRow = Selectable<AuthProfileStoreDatabase["auth_profile_state"]>;
type AuthProfileStorePayloadRow = Pick<AuthProfileStoreRow, "store_json" | "updated_at">;
type AuthProfileStatePayloadRow = Pick<AuthProfileStateRow, "state_json" | "updated_at">;
type AuthProfileStorageOptions = OpenClawStateDatabaseOptions & { now?: () => number };

type PayloadRow = AuthProfileStorePayloadRow | AuthProfileStatePayloadRow;

function parseJsonValue(raw: string): AuthProfilePayloadValue | undefined {
  try {
    return JSON.parse(raw) as AuthProfilePayloadValue;
  } catch {
    return undefined;
  }
}

function rowToReadResult(row: PayloadRow | undefined): AuthProfilePayloadReadResult {
  if (!row) {
    return { exists: false };
  }
  const raw = "store_json" in row ? row.store_json : row.state_json;
  return {
    exists: true,
    value: raw === undefined ? undefined : parseJsonValue(raw),
    updatedAt: row.updated_at,
  };
}

function authProfileStorePayloadToRow(
  storeKey: string,
  value: AuthProfilePayloadValue,
  updatedAt: number,
): AuthProfileStoreInsert {
  return {
    store_key: storeKey,
    store_json: JSON.stringify(value),
    updated_at: updatedAt,
  };
}

function authProfileStatePayloadToRow(
  storeKey: string,
  value: AuthProfilePayloadValue,
  updatedAt: number,
): AuthProfileStateInsert {
  return {
    store_key: storeKey,
    state_json: JSON.stringify(value),
    updated_at: updatedAt,
  };
}

export function readAuthProfileStorePayloadResult(
  storeKey: string,
  options: OpenClawStateDatabaseOptions = {},
): AuthProfilePayloadReadResult {
  return readAuthProfileStorePayloadResultFromDatabase(
    openOpenClawStateDatabase(options),
    storeKey,
  );
}

export function readAuthProfileStorePayloadResultFromDatabase(
  database: OpenClawStateDatabase,
  storeKey: string,
): AuthProfilePayloadReadResult {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("auth_profile_stores")
      .select(["store_json", "updated_at"])
      .where("store_key", "=", storeKey),
  );
  return rowToReadResult(row);
}

export function writeAuthProfileStorePayload(
  storeKey: string,
  value: AuthProfilePayloadValue,
  options: AuthProfileStorageOptions = {},
): void {
  const updatedAt = options.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    writeAuthProfileStorePayloadInTransaction(database, storeKey, value, updatedAt);
  }, options);
}

export function writeAuthProfileStorePayloadInTransaction(
  database: OpenClawStateDatabase,
  storeKey: string,
  value: AuthProfilePayloadValue,
  updatedAt: number,
): void {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  const row = authProfileStorePayloadToRow(storeKey, value, updatedAt);
  const { store_key: _storeKey, ...updates } = row;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("auth_profile_stores")
      .values(row)
      .onConflict((conflict) => conflict.column("store_key").doUpdateSet(updates)),
  );
}

export function deleteAuthProfileStorePayload(
  storeKey: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    deleteAuthProfileStorePayloadInTransaction(database, storeKey);
  }, options);
}

export function deleteAuthProfileStorePayloadInTransaction(
  database: OpenClawStateDatabase,
  storeKey: string,
): void {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("auth_profile_stores").where("store_key", "=", storeKey),
  );
}

export function readAuthProfileStatePayloadResult(
  storeKey: string,
  options: OpenClawStateDatabaseOptions = {},
): AuthProfilePayloadReadResult {
  return readAuthProfileStatePayloadResultFromDatabase(
    openOpenClawStateDatabase(options),
    storeKey,
  );
}

export function readAuthProfileStatePayloadResultFromDatabase(
  database: OpenClawStateDatabase,
  storeKey: string,
): AuthProfilePayloadReadResult {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("auth_profile_state")
      .select(["state_json", "updated_at"])
      .where("store_key", "=", storeKey),
  );
  return rowToReadResult(row);
}

export function writeAuthProfileStatePayload(
  storeKey: string,
  value: AuthProfilePayloadValue,
  options: AuthProfileStorageOptions = {},
): void {
  const updatedAt = options.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    writeAuthProfileStatePayloadInTransaction(database, storeKey, value, updatedAt);
  }, options);
}

export function writeAuthProfileStatePayloadInTransaction(
  database: OpenClawStateDatabase,
  storeKey: string,
  value: AuthProfilePayloadValue,
  updatedAt: number,
): void {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  const row = authProfileStatePayloadToRow(storeKey, value, updatedAt);
  const { store_key: _storeKey, ...updates } = row;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("auth_profile_state")
      .values(row)
      .onConflict((conflict) => conflict.column("store_key").doUpdateSet(updates)),
  );
}

export function deleteAuthProfileStatePayload(
  storeKey: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    deleteAuthProfileStatePayloadInTransaction(database, storeKey);
  }, options);
}

export function deleteAuthProfileStatePayloadInTransaction(
  database: OpenClawStateDatabase,
  storeKey: string,
): void {
  const db = getNodeSqliteKysely<AuthProfileStoreDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("auth_profile_state").where("store_key", "=", storeKey),
  );
}
