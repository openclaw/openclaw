/**
 * SQLite persistence adapter for auth profile secrets and runtime state.
 * The public helpers expose raw JSON payloads so normalization stays in the
 * store/state layers that own compatibility rules.
 */
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { assertEngineStoreExecutionAllowed } from "../../infra/database-engine/admission-scope.js";
import { getDatabaseEngineInput } from "../../infra/database-engine/context.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../../infra/node-sqlite.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { openSqliteReadOnlyDatabase } from "../../infra/sqlite-snapshot-source.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { agentDatabaseLifecycle } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  assertExistingAgentSchemaOwner,
  readExistingAgentSchemaMeta,
} from "../../state/openclaw-agent-db-schema-helpers.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openClawStateDatabaseCache } from "../../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "../../utils.js";
import { resolveRegisteredAgentIdForDir } from "../agent-dir-registry.js";
import {
  prepareAuthProfileAuthorizationWrite,
  readAuthProfileAuthorizationLifetimes,
} from "./authorization-lifetime.js";
import {
  fenceAuthProfileAuthorizationWrite,
  publishAuthProfileAuthorization,
} from "./authorization-observation.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { withAuthProfileCredentialOwner } from "./credential-write-custody.js";
import {
  getPreparedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { prepareFreshSharedAuthStoreWriteAsync } from "./shared-store-bootstrap-async.js";
import {
  isSharedAuthProfileWrite,
  prepareFreshSharedAuthStoreWrite,
} from "./shared-store-bootstrap.js";
import { writeAuthProfileJsonCell, deleteAuthProfileJsonCell } from "./sqlite-json-write.js";
import {
  inspectAuthProfileJsonCell,
  inspectAgentAuthProfileJsonCellReadOnly,
  readAuthProfileJsonCellText,
  readAuthProfileRows,
  readAuthProfileRowsReadOnly,
} from "./sqlite-json.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadPool,
  isMissingDatabasePath,
} from "./sqlite-read-pool.js";
import type {
  AuthProfileRowRead,
  AuthProfileStoreOwner,
  PersistedAuthProfileStoreInspection,
  PreparedAuthProfileStoreOwner,
} from "./types.js";

export { closeAuthProfileReadPool };

export type AuthProfileDatabase = OpenClawAgentDatabase | OpenClawStateDatabase;

export function resolveAuthProfileStoreOwner(
  database: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStoreOwner | PreparedAuthProfileStoreOwner {
  const prepared = authProfileTransactions.get(database);
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
  prepareSharedAuthStoreOwnershipForNative(env);
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

const authProfileTransactions = new WeakMap<AuthProfileDatabase, PreparedAuthProfileStoreOwner>();

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
  if (!agentDir) {
    prepareSharedAuthStoreOwnershipForNative(env);
  }
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
  if (getDatabaseEngineInput("agent")) {
    const opened = openOpenClawAgentDatabaseReadOnly({ agentId, path: pathname });
    if (opened.found) {
      opened.database.close();
    }
    return;
  }
  const acquired = acquireAuthProfileReadDatabase(pathname, openSqliteReadOnlyDatabase);
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

function readSelectedAgentAuthDatabase<T>(
  target: { path: string; env?: NodeJS.ProcessEnv },
  read: (db: EngineConnection) => T,
): { value: T } | undefined {
  assertEngineStoreExecutionAllowed();
  if (isMissingDatabasePath(target.path)) {
    return undefined;
  }
  const anchor = openNodeSqliteDatabase(resolveExistingSqliteFileUri(target.path));
  let database: EngineConnection = anchor;
  try {
    database = openAgentEngineStore(anchor, undefined, target.path, true, (connection, error) => {
      database = connection;
      throw error;
    });
    return { value: read(database) };
  } finally {
    try {
      database.close();
    } finally {
      if (database !== anchor && anchor.isOpen) {
        anchor.close();
      }
    }
  }
}

function readAuthProfileDatabaseReadOnly<T>(
  databaseTarget: Pick<AuthProfileDatabaseTarget, "kind" | "path"> & { env?: NodeJS.ProcessEnv },
  reader: {
    read: (db: EngineConnection, kind: AuthProfileDatabaseTarget["kind"]) => T;
    readNativeAgent: (databasePath: string) => T;
    unavailable: (inspection: PersistedAuthProfileStoreInspection) => T;
  },
): T {
  if (databaseTarget.kind === "shared-state") {
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(({ db }) => reader.read(db, "shared-state"), {
          path: databaseTarget.path,
          ...(databaseTarget.env ? { env: databaseTarget.env } : {}),
        }) ?? reader.unavailable({ status: "missing", reason: "database" })
      );
    } catch {
      return reader.unavailable(
        isMissingDatabasePath(databaseTarget.path)
          ? { status: "missing", reason: "database" }
          : { status: "unreadable" },
      );
    }
  }
  if (getDatabaseEngineInput("agent")) {
    try {
      return (
        readSelectedAgentAuthDatabase(databaseTarget, (db) => reader.read(db, "agent"))?.value ??
        reader.unavailable({ status: "missing", reason: "database" })
      );
    } catch {
      return reader.unavailable({ status: "unreadable" });
    }
  }
  return reader.readNativeAgent(databaseTarget.path);
}

export function inspectAuthProfileJsonCellReadOnly(
  databaseTarget: Pick<AuthProfileDatabaseTarget, "kind" | "path"> & { env?: NodeJS.ProcessEnv },
  target: "store" | "state",
): PersistedAuthProfileStoreInspection {
  return readAuthProfileDatabaseReadOnly(databaseTarget, {
    read: (db, kind) => inspectAuthProfileJsonCell(db, target, kind),
    readNativeAgent: (databasePath) =>
      inspectAgentAuthProfileJsonCellReadOnly(databasePath, target, openSqliteReadOnlyDatabase),
    unavailable: (inspection) => inspection,
  });
}

export function readPersistedAuthProfileRows(
  agentDir?: string,
  env?: NodeJS.ProcessEnv,
): AuthProfileRowRead {
  const target = resolveAuthProfileDatabaseOptions(agentDir, env);
  return readAuthProfileDatabaseReadOnly(target, {
    read: (db, kind) => readAuthProfileRows(db, target.path, kind),
    readNativeAgent: (databasePath) =>
      readAuthProfileRowsReadOnly(databasePath, openSqliteReadOnlyDatabase),
    unavailable: (inspection) => ({ store: inspection, state: inspection, cacheable: false }),
  });
}

/** Doctor retains opaque rotation-state bytes while repairing independently readable credentials. */
export function readAuthProfileStateJsonTextReadOnly(
  target: Pick<AuthProfileDatabaseTarget, "kind" | "path"> & { env?: NodeJS.ProcessEnv },
): string | undefined {
  if (target.kind === "shared-state") {
    return withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readAuthProfileJsonCellText(db, "state", "shared-state"),
      { path: target.path, ...(target.env ? { env: target.env } : {}) },
    );
  }
  if (getDatabaseEngineInput("agent")) {
    const result = readSelectedAgentAuthDatabase(target, (db) =>
      readAuthProfileJsonCellText(db, "state", "agent"),
    );
    if (!result) {
      throw new Error("Auth profile rotation-state source is unavailable; retry Doctor.");
    }
    return result.value;
  }
  const acquired = acquireAuthProfileReadDatabase(target.path, openSqliteReadOnlyDatabase);
  if (acquired.status !== "readable") {
    throw new Error("Auth profile rotation-state source is unavailable; retry Doctor.");
  }
  return readAuthProfileJsonCellText(acquired.db, "state", "agent");
}

function inspectPersistedAuthProfileCell(
  target: "store" | "state",
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      target,
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(resolveAuthProfileDatabaseOptions(agentDir), target);
}

/** Distinguishes an absent auth row from a present store that could not be read. */
export function inspectPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  return inspectPersistedAuthProfileCell("store", agentDir, database);
}

/** Distinguishes an absent auth-state row from state that could not be read. */
export function inspectPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  return inspectPersistedAuthProfileCell("state", agentDir, database);
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

function readPersistedAuthProfileCell(
  target: "store" | "state",
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  if (database) {
    return parseJsonCell(
      readAuthProfileJsonCellText(
        database.db,
        target,
        resolveAuthProfileDatabaseKind(agentDir, database),
      ),
    );
  }
  const result = inspectPersistedAuthProfileCell(target, agentDir);
  return result.status === "readable" ? result.raw : null;
}

/** Reads the raw persisted secrets-store payload without coercing the schema. */
export function readPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  return readPersistedAuthProfileCell("store", agentDir, database);
}

/** Reads the raw persisted runtime-state payload without coercing the schema. */
export function readPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  return readPersistedAuthProfileCell("state", agentDir, database);
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
  mutateAuthProfileCell("store", payload, agentDir, database);
}

/** Deletes the persisted secrets-store row while leaving runtime state intact. */
export function deletePersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  mutateAuthProfileCell("store", undefined, agentDir, database, true);
}

/** Writes or deletes the persisted runtime-state payload. */
export function writePersistedAuthProfileStateRaw(
  payload: unknown,
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  mutateAuthProfileCell("state", payload, agentDir, database, !payload);
}

function mutateAuthProfileCell(
  target: "store" | "state",
  payload: unknown,
  agentDir: string | undefined,
  database: AuthProfileDatabase | undefined,
  deleteRow = false,
): void {
  const kind = resolveAuthProfileDatabaseKind(agentDir, database);
  const write = (owner: AuthProfileDatabase) => {
    let next = payload;
    let remove = deleteRow;
    if (target === "store") {
      const previous = inspectAuthProfileJsonCell(owner.db, target, kind);
      if (previous.status === "unreadable") {
        throw new Error("Auth profile credential store is unreadable");
      }
      const raw = previous.status === "readable" ? previous.raw : undefined;
      if (remove && Object.keys(readAuthProfileAuthorizationLifetimes(raw)).length) {
        // Preserve enrolled selection tombstones through credential removal.
        next = { version: AUTH_STORE_VERSION, profiles: {} };
        remove = false;
      }
      if (!remove) {
        next = prepareAuthProfileAuthorizationWrite(raw, next);
      }
    }
    let settleAuthorization: ReturnType<typeof fenceAuthProfileAuthorizationWrite> | undefined;
    const fenceAuthorization = () => {
      settleAuthorization ??= fenceAuthProfileAuthorizationWrite(owner.path);
    };
    // Autocommit has no later prepareCommit phase; fence before its native effect.
    if (target === "store" && !owner.db.isTransaction) {
      fenceAuthorization();
    }
    try {
      if (remove) {
        deleteAuthProfileJsonCell(owner.db, target, kind);
      } else {
        writeAuthProfileJsonCell(owner.db, target, kind, next);
      }
      if (target === "store") {
        const publish = () => {
          publishAuthProfileAuthorization(owner.path, remove ? undefined : next);
          settleAuthorization?.(true);
        };
        // The supplied connection retains its outer transaction/savepoint owner. Unknown
        // settlement must invalidate facts even when post-commit notifications are discarded.
        if (
          !stageSqliteTransactionState(owner.db, {
            stage() {},
            prepareCommit: fenceAuthorization,
            commit: publish,
            rollback: () => settleAuthorization?.(true),
            invalidate() {
              fenceAuthorization();
              settleAuthorization?.(false);
            },
          })
        ) {
          publish();
        }
      }
    } catch (error) {
      settleAuthorization?.(false);
      throw error;
    }
  };
  if (database) {
    write(database);
  } else {
    runAuthProfileWriteTransaction(agentDir, write);
  }
}

type AuthProfileWriteOptions = {
  env?: NodeJS.ProcessEnv;
  sharedStoreWrite?: boolean;
  stateDir?: string;
  assertEnvironment?: (env: NodeJS.ProcessEnv) => void;
  existingDatabaseTarget?: {
    kind: "agent";
    agentId: string;
    path: string;
    env: NodeJS.ProcessEnv;
    identity: DatabaseFileIdentity;
    assertCurrent: () => void;
  };
};

export function prepareAuthProfileWriteEnvironment(
  options: AuthProfileWriteOptions,
): NodeJS.ProcessEnv {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  if (!options.env && options.stateDir) {
    env.OPENCLAW_STATE_DIR = options.stateDir;
    env.OPENCLAW_AGENT_DIR = undefined;
  }
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  options.assertEnvironment?.(env);
  return env;
}

/** Released synchronous SDK writes and Doctor one-shots retain their native preparation. */
export function prepareAuthProfileWriteTransaction(
  agentDir: string | undefined,
  options: AuthProfileWriteOptions,
  env = prepareAuthProfileWriteEnvironment(options),
) {
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

export async function prepareAuthProfileWriteTransactionAsync(
  agentDir: string | undefined,
  options: AuthProfileWriteOptions,
  assertCurrent?: () => void,
) {
  const env = prepareAuthProfileWriteEnvironment(options);
  const capturedAgentDir = agentDir ? resolveUserPath(agentDir, env) : undefined;
  const sharedStoreWrite = await prepareFreshSharedAuthStoreWriteAsync({
    agentDir: capturedAgentDir,
    allowExplicitMain: options.sharedStoreWrite === true,
    env,
    assertCurrent,
  });
  options.assertEnvironment?.(env);
  assertCurrent?.();
  const databaseTarget = resolveAuthProfileDatabaseOptions(
    sharedStoreWrite ? undefined : capturedAgentDir,
    env,
  );
  return { databaseTarget, sharedOwner: prepareAuthProfileSharedOwner(env) };
}

/** An open connection can retain custody beyond the preceding SDK call. */
function getCachedAuthProfileWriteConnection(
  agentDir: string | undefined,
  options: AuthProfileWriteOptions,
  env: NodeJS.ProcessEnv,
) {
  if (options.existingDatabaseTarget) {
    return agentDatabaseLifecycle.databases.get(path.resolve(options.existingDatabaseTarget.path))
      ?.db;
  }
  if (
    agentDir === undefined ||
    isSharedAuthProfileWrite({
      agentDir,
      allowExplicitMain: options.sharedStoreWrite === true,
      env,
    })
  ) {
    const ownership = getPreparedSharedAuthStoreOwnership(env);
    // A retained shared-root lease also admits cold ownership discovery.
    if (!ownership || ownership.location === "state-db") {
      return openClawStateDatabaseCache.peekOpenClawStateDatabaseConnection(
        resolveOpenClawStateSqlitePath(env),
      );
    }
    return agentDatabaseLifecycle.databases.get(
      path.resolve(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
    )?.db;
  }
  return agentDatabaseLifecycle.databases.get(
    path.resolve(resolveAuthProfileDatabasePath(agentDir)),
  )?.db;
}

/** Runs an auth-profile database write transaction for store/state updates. */
export function runAuthProfileWriteTransaction<T>(
  agentDir: string | undefined,
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
  options: AuthProfileWriteOptions = {},
): T {
  const existing = options.existingDatabaseTarget;
  const env = existing?.env ?? prepareAuthProfileWriteEnvironment(options);
  const cachedDatabase = getCachedAuthProfileWriteConnection(agentDir, options, env);
  return withAuthProfileCredentialOwner(
    resolveOpenClawStateSqlitePath(env),
    (retain) => {
      const { databaseTarget, sharedOwner } = existing
        ? { databaseTarget: existing, sharedOwner: prepareAuthProfileSharedOwner(env) }
        : prepareAuthProfileWriteTransaction(agentDir, options, env);
      const run = (database: AuthProfileDatabase) => {
        retain?.(database.db);
        const previous = authProfileTransactions.get(database);
        const owner = previous ?? { ...sharedOwner, databasePath: database.path };
        authProfileTransactions.set(database, owner);
        try {
          return operation(database, owner);
        } finally {
          if (!previous) {
            authProfileTransactions.delete(database);
          }
        }
      };
      if (databaseTarget.kind === "agent") {
        return runOpenClawAgentWriteTransaction(run, databaseTarget, {
          operationLabel: "auth-profiles.write",
          ...(existing
            ? {
                repairAdmission: {
                  integrityTables: ["auth_profile_store", "auth_profile_state"],
                  expectedIdentity: existing.identity,
                  assertCurrent: existing.assertCurrent,
                },
              }
            : {}),
        });
      }
      const database = openOpenClawStateDatabase({ env, path: databaseTarget.path });
      return runOpenClawStateWriteTransaction(run, { env, database });
    },
    cachedDatabase,
  );
}
