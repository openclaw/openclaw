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
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  assertExistingAgentSchemaOwner,
  readExistingAgentSchemaMeta,
} from "../../state/openclaw-agent-db-schema-helpers.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveUserPath } from "../../utils.js";
import { resolveRegisteredAgentIdForDir } from "../agent-dir-registry.js";
import {
  prepareAuthProfileAuthorizationWrite,
  readAuthProfileAuthorizationLifetimes,
} from "./authorization-lifetime.js";
import { publishAuthProfileAuthorization } from "./authorization-observation.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { prepareFreshSharedAuthStoreWriteAsync } from "./shared-store-bootstrap-async.js";
import { prepareFreshSharedAuthStoreWrite } from "./shared-store-bootstrap.js";
import {
  inspectAuthProfileJsonCell,
  inspectAgentAuthProfileJsonCellReadOnly,
  readAuthProfileJsonCellText,
  writeAuthProfileJsonCell,
  deleteAuthProfileJsonCell,
} from "./sqlite-json.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadPool,
  isMissingDatabasePath,
} from "./sqlite-read-pool.js";
import type {
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
  const acquired = acquireAuthProfileReadDatabase(target.path);
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
    if (remove) {
      deleteAuthProfileJsonCell(owner.db, target, kind);
    } else {
      writeAuthProfileJsonCell(owner.db, target, kind, next);
    }
    if (target === "store") {
      const publish = () => publishAuthProfileAuthorization(owner.path, remove ? undefined : next);
      if (!deferSqlitePostCommitPublication(owner.db, publish)) {
        publish();
      }
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
) {
  const env = prepareAuthProfileWriteEnvironment(options);
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

/** Runs an auth-profile database write transaction for store/state updates. */
export function runAuthProfileWriteTransaction<T>(
  agentDir: string | undefined,
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
  options: AuthProfileWriteOptions = {},
): T {
  const { databaseTarget, sharedOwner } = prepareAuthProfileWriteTransaction(agentDir, options);
  const run = (database: AuthProfileDatabase) => {
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
    });
  }
  const { env } = databaseTarget;
  const database = openOpenClawStateDatabase({ env, path: databaseTarget.path });
  return runOpenClawStateWriteTransaction(run, { env, database });
}
