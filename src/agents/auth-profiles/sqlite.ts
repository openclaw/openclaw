/**
 * SQLite persistence adapter for auth profile secrets and runtime state.
 * The public helpers expose raw JSON payloads so normalization stays in the
 * store/state layers that own compatibility rules.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db.js";
import { resolveUserPath } from "../../utils.js";
import { resolveRegisteredAgentIdForDir } from "../agent-dir-registry.js";
import { resolveDefaultAgentDir } from "../agent-scope-config.js";

type AuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
const PRIMARY_ROW_KEY = "primary";

function resolveAgentDir(agentDir?: string): string {
  return resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
}

function inferAgentIdFromDir(agentDir: string): string {
  const normalized = path.normalize(agentDir);
  if (path.basename(normalized) === "agent") {
    const parent = path.basename(path.dirname(normalized));
    if (parent) {
      return parent;
    }
  }
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `custom-${hash}`;
}

// The auth database lives in the agent dir and shares the openclaw-agent schema
// so auth store/state can move with the rest of agent-local durable state.
function resolveAuthProfileDatabaseOptions(agentDir?: string) {
  const dir = resolveAgentDir(agentDir);
  return {
    agentId: resolveRegisteredAgentIdForDir(dir) ?? inferAgentIdFromDir(dir),
    path: path.join(dir, "openclaw-agent.sqlite"),
  };
}

/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export function resolveAuthProfileDatabasePath(agentDir?: string): string {
  return resolveAuthProfileDatabaseOptions(agentDir).path;
}

/** Resolves the SQLite database and sidecar paths used by auth profiles. */
export function resolveAuthProfileDatabaseFilePaths(agentDir?: string): string[] {
  return resolveSqliteDatabaseFilePaths(resolveAuthProfileDatabasePath(agentDir));
}

// Read-only probes must tolerate old/corrupt/missing rows. Coercion happens
// above this layer; this layer only returns raw JSON-ish payloads.
function parseJsonCell(raw: string | null | undefined): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Discriminated outcome for raw auth-store reads that must distinguish a
 * legitimately absent store (missing DB file, missing row, or an empty/NULL
 * JSON cell) from an UNREADABLE one (SQLite open/query failure, or a present
 * but malformed JSON payload that `JSON.parse` rejects).
 *
 * The plain `readPersistedAuthProfileStoreRaw` collapses both failure shapes
 * onto `null`, which is correct for callers that only want a best-effort
 * payload, but unsafe for the models-config ready-cache fingerprint: an
 * unreadable/corrupt store fingerprinted as `absent` lets stale provider/auth
 * discovery ride a cache hit instead of forcing a fail-closed re-plan
 * (Codex P1 on PR #90741, models-config.ts:301). The fingerprint path uses
 * this outcome-returning reader so it can treat `unreadable` as uncacheable.
 */
export type AuthProfileStoreRawReadOutcome =
  | { kind: "present"; data: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; error: unknown };

// Parse a JSON cell into a discriminated outcome.  An empty / NULL cell is a
// legitimate absent row; a non-empty string that fails `JSON.parse` is a
// malformed payload — surfaced as `unreadable` rather than masquerading as
// absent.
function parseJsonCellOutcome(raw: string | null | undefined): AuthProfileStoreRawReadOutcome {
  if (!raw) {
    return { kind: "absent" };
  }
  try {
    return { kind: "present", data: JSON.parse(raw) as unknown };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

function getAuthProfileKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuthProfileDatabase>(db);
}

function readAuthProfileJsonCellReadOnly(pathname: string, target: "store" | "state"): unknown {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname, { readOnly: true });
  try {
    // This short-lived reader bypasses the canonical agent DB bootstrap, but it
    // must share its busy policy so brief rollback-journal locks do not look
    // like missing credentials.
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const kysely = getAuthProfileKysely(db);
    if (target === "store") {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("auth_profile_store")
          .select("store_json")
          .where("store_key", "=", PRIMARY_ROW_KEY),
      );
      return parseJsonCell(row?.store_json);
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.state_json);
  } catch {
    return null;
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

// Outcome-returning twin of `readAuthProfileJsonCellReadOnly` for the store
// row.  Unlike the plain reader, it distinguishes a SQLite open/query failure
// or a malformed JSON cell (`unreadable`) from a legitimately empty row
// (`absent`).  Only the store target is needed today (the fingerprint path);
// keep it store-scoped rather than generalizing prematurely.
function readAuthProfileStoreCellOutcomeReadOnly(pathname: string): AuthProfileStoreRawReadOutcome {
  const sqlite = requireNodeSqlite();
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(pathname, { readOnly: true });
  } catch (error) {
    return { kind: "unreadable", error };
  }
  try {
    // Keep parity with the plain read-only auth helper so transient writer locks
    // do not turn a readable store into an uncacheable auth fingerprint.
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const kysely = getAuthProfileKysely(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCellOutcome(row?.store_json);
  } catch (error) {
    return { kind: "unreadable", error };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

/** Reads the raw persisted secrets-store payload without coercing the schema. */
export function readPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): unknown {
  if (database) {
    const db = getAuthProfileKysely(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.store_json);
  }
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  return readAuthProfileJsonCellReadOnly(databasePath, "store");
}

/**
 * Reads the raw persisted secrets-store payload as a discriminated outcome
 * that distinguishes a legitimately absent store from an unreadable/corrupt
 * one.  Mirrors `readPersistedAuthProfileStoreRaw`'s no-create, read-only
 * behavior (checks `fs.existsSync` before opening, opens `{ readOnly: true }`)
 * but never collapses a SQLite open/query failure or malformed JSON cell onto
 * the absent case.  The models-config ready-cache fingerprint uses this so an
 * untrusted auth-store read fails closed (uncacheable → re-plan) instead of
 * masquerading as "no auth profiles configured" (Codex P1 on PR #90741).
 */
export function readPersistedAuthProfileStoreRawOutcome(
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): AuthProfileStoreRawReadOutcome {
  if (database) {
    try {
      const db = getAuthProfileKysely(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("auth_profile_store")
          .select("store_json")
          .where("store_key", "=", PRIMARY_ROW_KEY),
      );
      return parseJsonCellOutcome(row?.store_json);
    } catch (error) {
      return { kind: "unreadable", error };
    }
  }
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  if (!fs.existsSync(databasePath)) {
    return { kind: "absent" };
  }
  return readAuthProfileStoreCellOutcomeReadOnly(databasePath);
}

/** Reads the raw persisted runtime-state payload without coercing the schema. */
export function readPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): unknown {
  if (database) {
    const db = getAuthProfileKysely(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.state_json);
  }
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  return readAuthProfileJsonCellReadOnly(databasePath, "state");
}

/** Writes the raw persisted secrets-store payload inside the auth database. */
export function writePersistedAuthProfileStoreRaw(
  payload: unknown,
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): void {
  const write = (target: OpenClawAgentDatabase) => {
    const db = getAuthProfileKysely(target.db);
    executeSqliteQuerySync(
      target.db,
      db
        .insertInto("auth_profile_store")
        .values({
          store_key: PRIMARY_ROW_KEY,
          store_json: JSON.stringify(payload),
          updated_at: Date.now(),
        })
        .onConflict((conflict) =>
          conflict.column("store_key").doUpdateSet({
            store_json: JSON.stringify(payload),
            updated_at: Date.now(),
          }),
        ),
    );
  };
  if (database) {
    write(database);
    return;
  }
  runOpenClawAgentWriteTransaction(write, resolveAuthProfileDatabaseOptions(agentDir));
}

/** Deletes the persisted secrets-store row while leaving runtime state intact. */
export function deletePersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): void {
  const remove = (target: OpenClawAgentDatabase) => {
    const db = getAuthProfileKysely(target.db);
    executeSqliteQuerySync(
      target.db,
      db.deleteFrom("auth_profile_store").where("store_key", "=", PRIMARY_ROW_KEY),
    );
  };
  if (database) {
    remove(database);
    return;
  }
  runOpenClawAgentWriteTransaction(remove, resolveAuthProfileDatabaseOptions(agentDir));
}

/** Writes or deletes the persisted runtime-state payload. */
export function writePersistedAuthProfileStateRaw(
  payload: unknown,
  agentDir?: string,
  database?: OpenClawAgentDatabase,
): void {
  const write = (target: OpenClawAgentDatabase) => {
    const db = getAuthProfileKysely(target.db);
    if (!payload) {
      executeSqliteQuerySync(
        target.db,
        db.deleteFrom("auth_profile_state").where("state_key", "=", PRIMARY_ROW_KEY),
      );
      return;
    }
    executeSqliteQuerySync(
      target.db,
      db
        .insertInto("auth_profile_state")
        .values({
          state_key: PRIMARY_ROW_KEY,
          state_json: JSON.stringify(payload),
          updated_at: Date.now(),
        })
        .onConflict((conflict) =>
          conflict.column("state_key").doUpdateSet({
            state_json: JSON.stringify(payload),
            updated_at: Date.now(),
          }),
        ),
    );
  };
  if (database) {
    write(database);
    return;
  }
  runOpenClawAgentWriteTransaction(write, resolveAuthProfileDatabaseOptions(agentDir));
}

/** Runs an auth-profile database write transaction for store/state updates. */
export function runAuthProfileWriteTransaction<T>(
  agentDir: string | undefined,
  operation: (database: OpenClawAgentDatabase) => T,
): T {
  return runOpenClawAgentWriteTransaction(operation, resolveAuthProfileDatabaseOptions(agentDir));
}
