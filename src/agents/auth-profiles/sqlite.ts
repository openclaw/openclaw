/**
 * SQLite persistence adapter for auth profile secrets and runtime state.
 * The public helpers expose raw JSON payloads so normalization stays in the
 * store/state layers that own compatibility rules.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  assertExistingAgentSchemaOwner,
  readExistingAgentSchemaMeta,
} from "../../state/openclaw-agent-db-schema-helpers.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveUserPath } from "../../utils.js";
import { resolveRegisteredAgentIdForDir } from "../agent-dir-registry.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
  type SharedAuthStoreOwnership,
} from "./path-resolve.js";
import { prepareFreshSharedAuthStoreWrite } from "./shared-store-bootstrap.js";
import {
  PRIMARY_ROW_KEY,
  SHARED_STORE_STATE_KEY,
  SHARED_STATE_STATE_KEY,
  getAgentAuthProfileKysely,
  getSharedAuthProfileKysely,
  inspectAuthProfileJsonCell,
  inspectAgentAuthProfileJsonCellReadOnly,
  readSharedAuthKvCell,
} from "./sqlite-json.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadPool,
  isMissingDatabasePath,
} from "./sqlite-read-pool.js";
import type { PersistedAuthProfileStoreInspection } from "./types.js";

export { closeAuthProfileReadPool };

export type AuthProfileDatabase = OpenClawAgentDatabase | OpenClawStateDatabase;

/** Internal prepared ownership, carried through commit publication and compensation. */
export type AuthProfileStoreOwner = {
  databasePath: string;
  sharedDatabasePath: string;
  location: SharedAuthStoreOwnership["location"];
};

export type PreparedAuthProfileStoreOwner = AuthProfileStoreOwner & { env: NodeJS.ProcessEnv };

export function resolveAuthProfileStoreOwner(
  database: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStoreOwner | PreparedAuthProfileStoreOwner {
  const prepared = authProfileTransactions.get(database)?.owner;
  if (prepared) {
    return prepared;
  }
  // A supplied shared connection already names its owner; ambient discovery can
  // select another database (or fail on it) before this connection is ever used.
  if (!("agentId" in database)) {
    return { databasePath: database.path, sharedDatabasePath: database.path, location: "state-db" };
  }
  return {
    ...prepareAuthProfileSharedOwner(env),
    databasePath: database.path,
  };
}

function prepareAuthProfileSharedOwner(env: NodeJS.ProcessEnv) {
  const preparedEnv = cloneEnvWithPlatformSemantics(env);
  preparedEnv.OPENCLAW_STATE_DIR = resolveStateDir(preparedEnv);
  return {
    env: preparedEnv,
    sharedDatabasePath: resolveSharedAuthStorePath(preparedEnv),
    location: resolveSharedAuthStoreOwnership(preparedEnv).location,
  };
}

type AuthProfileDatabaseTarget =
  | { kind: "agent"; agentId: string; path: string; env: NodeJS.ProcessEnv }
  | { kind: "shared-state"; path: string; env: NodeJS.ProcessEnv };

function writeSharedAuthKvCell(db: DatabaseSync, stateKey: string, valueJson: string): void {
  executeSqliteQuerySync(
    db,
    getSharedAuthProfileKysely(db)
      .insertInto("config_machine_state")
      .values({ state_key: stateKey, value_json: valueJson, updated_at_ms: Date.now() })
      .onConflict((conflict) =>
        conflict
          .column("state_key")
          .doUpdateSet({ value_json: valueJson, updated_at_ms: Date.now() }),
      ),
  );
}

function deleteSharedAuthKvCell(db: DatabaseSync, stateKey: string): void {
  executeSqliteQuerySync(
    db,
    getSharedAuthProfileKysely(db)
      .deleteFrom("config_machine_state")
      .where("state_key", "=", stateKey),
  );
}
const authProfileTransactions = new WeakMap<
  AuthProfileDatabase,
  { owner: PreparedAuthProfileStoreOwner }
>();

function inferAgentIdFromDir(agentDir: string): string {
  const normalized = path.normalize(agentDir);
  if (path.basename(normalized) === "agent") {
    const parent = path.basename(path.dirname(normalized));
    if (parent) {
      return parent;
    }
  }
  return `custom-${sha256HexPrefixCore(normalized, 12)}`;
}

// The auth database lives in the agent dir and shares the openclaw-agent schema
// so auth store/state can move with the rest of agent-local durable state.
function resolveAuthProfileDatabaseOptions(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileDatabaseTarget {
  const pathname = agentDir
    ? resolveAuthProfileDatabasePath(agentDir)
    : resolveSharedAuthStorePath(env);
  if (!agentDir && resolveSharedAuthStoreOwnership(env).location === "state-db") {
    return { kind: "shared-state", path: pathname, env };
  }
  const dir = path.dirname(pathname);
  return {
    kind: "agent",
    agentId: resolveRegisteredAgentIdForDir(dir) ?? inferAgentIdFromDir(dir),
    path: pathname,
    env,
  };
}

/** Filename-only consumers do not need reverse agent ownership discovery. */
export function resolveAuthProfileDatabasePath(agentDir: string): string {
  return agentDir
    ? path.join(resolveUserPath(agentDir), "openclaw-agent.sqlite")
    : resolveSharedAuthStorePath();
}

/** Resolves the durable agent owner expected for an auth-profile database. */
export function resolveAuthProfileDatabaseOwnerId(agentDir: string): string {
  const target = resolveAuthProfileDatabaseOptions(agentDir);
  if (target.kind !== "agent") {
    throw new Error("agent auth database unexpectedly resolved to shared state");
  }
  return target.agentId;
}

/** Resolves the SQLite database and sidecar paths used by auth profiles. */
export function resolveAuthProfileDatabaseFilePaths(agentDir: string): string[] {
  return resolveSqliteDatabaseFilePaths(resolveAuthProfileDatabasePath(agentDir));
}

// Read-only probes must tolerate old/corrupt/missing rows. Coercion happens
// above this layer; this layer only returns raw JSON-ish payloads.
function parseJsonCell(raw: string | null | undefined): unknown {
  if (!raw) {
    return null;
  }
  return safeParseJson(raw) ?? null;
}

function resolveAuthProfileDatabaseKind(
  agentDir: string | undefined,
  database?: Pick<AuthProfileDatabase, "db">,
): AuthProfileDatabaseTarget["kind"] {
  if (database && "agentId" in database) {
    return "agent";
  }
  if (database && "path" in database) {
    return "shared-state";
  }
  return resolveAuthProfileDatabaseOptions(agentDir).kind;
}

/** Validate selected-agent ownership without requiring a current session schema. */
export function assertAuthProfileStoreAgentOwner(agentDir: string, agentId: string): void {
  const pathname = resolveAuthProfileDatabasePath(agentDir);
  const acquired = acquireAuthProfileReadDatabase(pathname);
  if (acquired.status === "missing") {
    return;
  }
  if (acquired.status === "unreadable") {
    throw new Error(`Unable to read agent auth database ${pathname}.`);
  }
  assertExistingAgentSchemaOwner(
    readExistingAgentSchemaMeta(acquired.db),
    normalizeAgentId(agentId),
    pathname,
  );
}

export function inspectAuthProfileJsonCellReadOnly(
  databaseTarget: Pick<AuthProfileDatabaseTarget, "kind" | "path"> & { env?: NodeJS.ProcessEnv },
  target: "store" | "state",
): PersistedAuthProfileStoreInspection {
  if (databaseTarget.kind === "shared-state") {
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => inspectAuthProfileJsonCell(db, target, "shared-state"),
          { path: databaseTarget.path, ...(databaseTarget.env ? { env: databaseTarget.env } : {}) },
        ) ?? { status: "missing", reason: "database" }
      );
    } catch {
      return isMissingDatabasePath(databaseTarget.path)
        ? { status: "missing", reason: "database" }
        : { status: "unreadable" };
    }
  }
  return inspectAgentAuthProfileJsonCellReadOnly(databaseTarget.path, target);
}

/** Distinguishes an absent auth row from a present store that could not be read. */
export function inspectPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "store",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(resolveAuthProfileDatabaseOptions(agentDir), "store");
}

/** Distinguishes an absent auth-state row from state that could not be read. */
export function inspectPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "state",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(resolveAuthProfileDatabaseOptions(agentDir), "state");
}

/** Inspect the shared store for an explicit state root without projecting it to an agent dir. */
export function inspectPersistedSharedAuthProfileStoreRaw(
  env: NodeJS.ProcessEnv,
): PersistedAuthProfileStoreInspection {
  return inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(undefined, env),
    "store",
  );
}

/** Inspect shared runtime state for an explicit state root. */
export function inspectPersistedSharedAuthProfileStateRaw(
  env: NodeJS.ProcessEnv,
): PersistedAuthProfileStoreInspection {
  return inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(undefined, env),
    "state",
  );
}

/** Reads the raw persisted secrets-store payload without coercing the schema. */
export function readPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      return parseJsonCell(readSharedAuthKvCell(database.db, SHARED_STORE_STATE_KEY));
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getAgentAuthProfileKysely(database.db)
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.store_json);
  }
  const result = inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(agentDir),
    "store",
  );
  return result.status === "readable" ? result.raw : null;
}

/** Reads the raw persisted runtime-state payload without coercing the schema. */
export function readPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      return parseJsonCell(readSharedAuthKvCell(database.db, SHARED_STATE_STATE_KEY));
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getAgentAuthProfileKysely(database.db)
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.state_json);
  }
  const result = inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(agentDir),
    "state",
  );
  return result.status === "readable" ? result.raw : null;
}

/** Read the shared credential row for an explicit state root. */
export function readPersistedSharedAuthProfileStoreRaw(env: NodeJS.ProcessEnv): unknown {
  const result = inspectPersistedSharedAuthProfileStoreRaw(env);
  return result.status === "readable" ? result.raw : null;
}

/** Read the shared runtime-state row for an explicit state root. */
export function readPersistedSharedAuthProfileStateRaw(env: NodeJS.ProcessEnv): unknown {
  const result = inspectPersistedSharedAuthProfileStateRaw(env);
  return result.status === "readable" ? result.raw : null;
}

/** Writes the raw persisted secrets-store payload inside the auth database. */
export function writePersistedAuthProfileStoreRaw(
  payload: unknown,
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const write = (target: AuthProfileDatabase) => {
    if (databaseKind === "shared-state") {
      writeSharedAuthKvCell(target.db, SHARED_STORE_STATE_KEY, JSON.stringify(payload));
      return;
    }
    executeSqliteQuerySync(
      target.db,
      getAgentAuthProfileKysely(target.db)
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
  runAuthProfileWriteTransaction(agentDir, write);
}

/** Deletes the persisted secrets-store row while leaving runtime state intact. */
export function deletePersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const remove = (target: AuthProfileDatabase) => {
    if (databaseKind === "shared-state") {
      deleteSharedAuthKvCell(target.db, SHARED_STORE_STATE_KEY);
      return;
    }
    executeSqliteQuerySync(
      target.db,
      getAgentAuthProfileKysely(target.db)
        .deleteFrom("auth_profile_store")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
  };
  if (database) {
    remove(database);
    return;
  }
  runAuthProfileWriteTransaction(agentDir, remove);
}

/** Writes or deletes the persisted runtime-state payload. */
export function writePersistedAuthProfileStateRaw(
  payload: unknown,
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const write = (target: AuthProfileDatabase) => {
    if (databaseKind === "shared-state") {
      if (!payload) {
        deleteSharedAuthKvCell(target.db, SHARED_STATE_STATE_KEY);
        return;
      }
      writeSharedAuthKvCell(target.db, SHARED_STATE_STATE_KEY, JSON.stringify(payload));
      return;
    }
    const db = getAgentAuthProfileKysely(target.db);
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
  runAuthProfileWriteTransaction(agentDir, write);
}

type AuthProfileWriteOptions = {
  env?: NodeJS.ProcessEnv;
  sharedStoreWrite?: boolean;
  stateDir?: string;
};

function prepareAuthProfileWriteTransaction(
  agentDir: string | undefined,
  options: AuthProfileWriteOptions,
) {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  if (!options.env && options.stateDir) {
    env.OPENCLAW_STATE_DIR = options.stateDir;
    env.OPENCLAW_AGENT_DIR = undefined;
  }
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const sharedStoreWrite = prepareFreshSharedAuthStoreWrite({
    agentDir,
    allowExplicitMain: options.sharedStoreWrite === true,
    env,
  });
  const databaseTarget = resolveAuthProfileDatabaseOptions(
    sharedStoreWrite ? undefined : agentDir,
    env,
  );
  // Shared-owner discovery may inspect another database; complete it before BEGIN.
  return { databaseTarget, sharedOwner: prepareAuthProfileSharedOwner(env) };
}

/** Runs an auth-profile database write transaction for store/state updates. */
export function runAuthProfileWriteTransaction<T>(
  agentDir: string | undefined,
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
  options: AuthProfileWriteOptions = {},
): T {
  return runPreparedAuthProfileWriteTransaction(
    prepareAuthProfileWriteTransaction(agentDir, options),
    operation,
  );
}

/** Queue the physical agent owner; relocated shared-state auth retains its own coordinator. */
export async function runAuthProfileWriteTransactionAsync<T>(
  agentDir: string | undefined,
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
  options: AuthProfileWriteOptions = {},
): Promise<T> {
  const prepared = prepareAuthProfileWriteTransaction(agentDir, options);
  const { databaseTarget } = prepared;
  if (databaseTarget.kind === "shared-state") {
    return runPreparedAuthProfileWriteTransaction(prepared, operation);
  }
  const assertCurrent = () => {
    // Doctor can relocate the shared base while this writer waits or validates.
    if (
      resolveSharedAuthStorePath(prepared.sharedOwner.env) !==
        prepared.sharedOwner.sharedDatabasePath ||
      resolveSharedAuthStoreOwnership(prepared.sharedOwner.env).location !==
        prepared.sharedOwner.location
    ) {
      throw new Error("Auth profile shared owner changed before write admission");
    }
  };
  return runOpenClawAgentWriteAdmission(
    databaseTarget,
    () =>
      withOpenClawAgentDatabaseAsync(
        databaseTarget,
        // The async owner retains the cached handle through this synchronous transaction.
        () => runPreparedAuthProfileWriteTransaction(prepared, operation),
        assertCurrent,
      ),
    true,
  );
}

function runPreparedAuthProfileWriteTransaction<T>(
  { databaseTarget, sharedOwner }: ReturnType<typeof prepareAuthProfileWriteTransaction>,
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
): T {
  const run = (database: AuthProfileDatabase) => {
    const previous = authProfileTransactions.get(database);
    const context = previous ?? { owner: { ...sharedOwner, databasePath: database.path } };
    authProfileTransactions.set(database, context);
    try {
      return operation(database, context.owner);
    } finally {
      if (!previous) {
        authProfileTransactions.delete(database);
      }
    }
  };
  if (databaseTarget.kind === "agent") {
    return runOpenClawAgentWriteTransaction(run, databaseTarget);
  }
  const { env } = databaseTarget;
  const database = openOpenClawStateDatabase({ env, path: databaseTarget.path });
  return runOpenClawStateWriteTransaction(run, { env, database });
}
