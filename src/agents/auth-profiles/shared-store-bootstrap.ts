import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertEngineStoreExecutionAllowed } from "../../infra/database-engine/admission-scope.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeWithCachedStatement } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { prepareSqliteReadOnlyLocationSync } from "../../infra/sqlite-snapshot-source.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { registerListener } from "../../shared/listeners.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { agentEngineInput, openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { resolveUserPath } from "../../utils.js";
import {
  resolveLegacyInheritedAuthAgentId,
  resolveLegacyInheritedAuthSourceAgentDirWithoutRegistration,
} from "../legacy-inherited-auth-dir.js";
import { listLegacyAuthProfileSources } from "./legacy-source-files.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import type { SharedAuthStoreOwnership } from "./types.js";

const PRIMARY_ROW_KEY = "primary";
export const SHARED_AUTH_STORE_MIGRATION_KIND = "shared-auth-store-state-db";

// Ownership objects are process-stable per state root. Doctor replaces the cached object
// after relocation, so legacy inspection is memoized only for that ownership generation.
const inspectedLegacySharedAuthOwnerships = new WeakSet<SharedAuthStoreOwnership>();

export function hasInspectedLegacySharedAuthOwnership(
  ownership: SharedAuthStoreOwnership,
): boolean {
  return inspectedLegacySharedAuthOwnerships.has(ownership);
}

export function noteInspectedLegacySharedAuthOwnership(ownership: SharedAuthStoreOwnership): void {
  inspectedLegacySharedAuthOwnerships.add(ownership);
}

export type FreshSharedAuthStoreHandoff = {
  previousSharedDatabasePath: string;
  sharedDatabasePath: string;
  env: NodeJS.ProcessEnv;
  sourceStillCurrent: boolean;
};
const freshSharedAuthStoreHandoffs = new Set<(handoff: FreshSharedAuthStoreHandoff) => void>();

/** Runtime views follow only this producer's proven empty-store relocation. */
export function registerFreshSharedAuthStoreHandoff(
  handoff: (receipt: FreshSharedAuthStoreHandoff) => void,
): () => void {
  return registerListener(freshSharedAuthStoreHandoffs, handoff);
}

type SourceAuthDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "migration_sources">;

export type SharedAuthLegacyStoreRow = { store_json: string; updated_at: number };
export type SharedAuthLegacyStateRow = { state_json: string; updated_at: number };
export type SharedAuthLegacyRows = {
  store: SharedAuthLegacyStoreRow | null;
  state: SharedAuthLegacyStateRow | null;
};

export type LegacySharedAuthSourceSelection = {
  sourceDir: string;
  sourcePath: string;
  ownerId: string;
  mainSourcePath: string;
  conflictingSourcePath?: string;
};

export class SharedAuthStoreSourceInspectionError extends Error {
  readonly code = "SHARED_AUTH_STORE_SOURCE_UNREADABLE" as const;
  readonly action = "openclaw doctor --fix" as const;
  readonly sourcePath: string;

  constructor(sourcePath: string, operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot ${operation} legacy shared auth database ${sourcePath}: ${detail}`, { cause });
    this.name = "SharedAuthStoreSourceInspectionError";
    this.sourcePath = sourcePath;
  }
}

export function inspectSharedAuthLegacySourceFile(
  sourcePath: string,
): { status: "missing" } | { status: "present"; size: number } {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(sourcePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { status: "missing" };
    }
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "inspect", error);
  }
  let target = entry;
  if (entry.isSymbolicLink()) {
    try {
      target = fs.statSync(sourcePath);
    } catch (error) {
      throw new SharedAuthStoreSourceInspectionError(sourcePath, "resolve", error);
    }
  }
  if (!target.isFile()) {
    throw new SharedAuthStoreSourceInspectionError(
      sourcePath,
      "open",
      new Error("path is not a regular file"),
    );
  }
  return { status: "present", size: target.size };
}

export function readSharedAuthLegacyRowsFromDatabase(
  database: EngineConnection,
): SharedAuthLegacyRows {
  const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
  // Legacy sources can predate either auth table; admit their shape once before the row batch.
  const tables = isPostgresSqlConnection(database)
    ? [{ name: "auth_profile_store" }, { name: "auth_profile_state" }]
    : executeWithCachedStatement(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        ["auth_profile_store", "auth_profile_state"],
        (statement) => statement.all("auth_profile_store", "auth_profile_state"),
      );
  const hasStore = tables.some((row) => row.name === "auth_profile_store");
  const hasState = tables.some((row) => row.name === "auth_profile_state");
  const store = db
    .selectFrom("auth_profile_store")
    .select(["store_json as json", "updated_at"])
    .select((expression) => expression.val("store").as("kind"))
    .where("store_key", "=", PRIMARY_ROW_KEY);
  const state = db
    .selectFrom("auth_profile_state")
    .select(["state_json as json", "updated_at"])
    .select((expression) => expression.val("state").as("kind"))
    .where("state_key", "=", PRIMARY_ROW_KEY);
  const query = hasStore
    ? hasState
      ? store.unionAll(state)
      : store
    : hasState
      ? state
      : undefined;
  const rows = query ? executeSqliteQuerySync(database, query).rows : [];
  const storeRow = rows.find((row) => row.kind === "store");
  const stateRow = rows.find((row) => row.kind === "state");
  return {
    store: storeRow ? { store_json: storeRow.json, updated_at: storeRow.updated_at } : null,
    state: stateRow ? { state_json: stateRow.json, updated_at: stateRow.updated_at } : null,
  };
}

export function inspectSharedAuthLegacyRowsReadOnly(
  sourcePath: string,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): SharedAuthLegacyRows {
  const postgres = agentEngineInput() !== undefined;
  if (postgres) {
    assertEngineStoreExecutionAllowed();
  }
  if (inspectSharedAuthLegacySourceFile(sourcePath).status === "missing") {
    return { store: null, state: null };
  }
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  try {
    // Prepare in a child: closing the original inode here can release this
    // process's live auth writer locks on Linux, even through a read-only handle.
    prepared =
      !postgres && behavior.artifactPreservingReadOnly
        ? prepareSqliteReadOnlyLocationSync(sourcePath)
        : undefined;
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "open", error);
  }
  try {
    let anchor: DatabaseSync;
    try {
      anchor = openNodeSqliteDatabase(prepared?.location ?? sourcePath, { readOnly: !postgres });
    } catch (error) {
      throw new SharedAuthStoreSourceInspectionError(sourcePath, "open", error);
    }
    let database: EngineConnection = anchor;
    try {
      if (postgres) {
        database = openAgentEngineStore(
          anchor,
          undefined,
          sourcePath,
          true,
          (connection, error) => {
            database = connection;
            throw error;
          },
        );
      }
      return readSharedAuthLegacyRowsFromDatabase(database);
    } catch (error) {
      throw new SharedAuthStoreSourceInspectionError(sourcePath, "read", error);
    } finally {
      try {
        database.close();
      } finally {
        if (database !== anchor && anchor.isOpen) {
          anchor.close();
        }
      }
    }
  } finally {
    prepared?.cleanup();
  }
}

export function hasPendingSharedAuthCleanup(
  env: NodeJS.ProcessEnv,
  sourcePath: string,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): boolean {
  const read = behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
    : withExistingOpenClawStateDatabaseReadOnly;
  return (
    read(
      ({ db: database }) => {
        if (behavior.artifactPreservingReadOnly && !tableExists(database, "migration_sources")) {
          return false;
        }
        return hasPendingSharedAuthCleanupInDatabase(database, sourcePath);
      },
      { env },
    ) ?? false
  );
}

export function hasPendingSharedAuthCleanupInDatabase(
  database: EngineConnection,
  sourcePath: string,
): boolean {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("migration_sources")
        .select("source_key")
        .where("migration_kind", "=", SHARED_AUTH_STORE_MIGRATION_KIND)
        .where("source_path", "=", sourcePath)
        .where("removed_source", "=", 0)
        .limit(1),
    ),
  );
}

/** Treat malformed profile payloads as populated so a repair never discards a secret. */
export function hasStoredSharedAuthProfiles(rows: SharedAuthLegacyRows): boolean {
  if (!rows.store) {
    return false;
  }
  const profiles = safeParseJsonRecord(rows.store.store_json)?.profiles;
  return !isRecord(profiles) || Object.keys(profiles).length > 0;
}

function hasLegacyAuthSources(agentDir: string, env: NodeJS.ProcessEnv): boolean {
  return listLegacyAuthProfileSources({ agentDir, env }).length > 0;
}

/**
 * Before cutover, main is still the read-through source for installations that never
 * used the configured owner. Select the only populated store, and leave both stores in
 * place when choosing either would silently change the credentials peers inherit.
 */
export function resolveLegacySharedAuthSourceSelection(params: {
  config: OpenClawConfig | undefined;
  env: NodeJS.ProcessEnv;
  ownershipLocation: "legacy-main" | "state-db";
  artifactPreservingReadOnly?: boolean;
}): LegacySharedAuthSourceSelection {
  const mainSourceDir = resolveSharedMainAuthAgentDir(params.env);
  const mainSourcePath = path.join(mainSourceDir, "openclaw-agent.sqlite");
  const configuredOwnerDir = resolveLegacyInheritedAuthSourceAgentDirWithoutRegistration(
    params.config,
    params.env,
  );
  const configuredOwnerId = normalizeAgentId(
    params.config ? resolveLegacyInheritedAuthAgentId(params.config) : LEGACY_IMPLICIT_AGENT_ID,
  );
  const configuredOwnerPath = path.join(configuredOwnerDir, "openclaw-agent.sqlite");
  const ownerIsMain =
    configuredOwnerId === LEGACY_IMPLICIT_AGENT_ID ||
    isSameOpenClawAgentDatabasePath(configuredOwnerPath, mainSourcePath);
  const main = {
    sourceDir: mainSourceDir,
    sourcePath: mainSourcePath,
    ownerId: LEGACY_IMPLICIT_AGENT_ID,
    mainSourcePath,
  };
  if (ownerIsMain) {
    return main;
  }
  if (hasPendingSharedAuthCleanup(params.env, configuredOwnerPath, params)) {
    return {
      sourceDir: configuredOwnerDir,
      sourcePath: configuredOwnerPath,
      ownerId: configuredOwnerId,
      mainSourcePath,
    };
  }
  if (hasPendingSharedAuthCleanup(params.env, mainSourcePath, params)) {
    return main;
  }
  if (params.ownershipLocation !== "legacy-main") {
    return main;
  }
  const ownerRows = inspectSharedAuthLegacyRowsReadOnly(configuredOwnerPath, params);
  const mainRows = inspectSharedAuthLegacyRowsReadOnly(mainSourcePath, params);
  const ownerPopulated =
    hasStoredSharedAuthProfiles(ownerRows) || hasLegacyAuthSources(configuredOwnerDir, params.env);
  const mainPopulated =
    hasStoredSharedAuthProfiles(mainRows) || hasLegacyAuthSources(mainSourceDir, params.env);
  const owner = {
    sourceDir: configuredOwnerDir,
    sourcePath: configuredOwnerPath,
    ownerId: configuredOwnerId,
    mainSourcePath,
  };
  if (ownerPopulated && mainPopulated) {
    return { ...owner, conflictingSourcePath: mainSourcePath };
  }
  return ownerPopulated ? owner : main;
}

export function publishFreshSharedAuthStoreHandoff(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
  sourceStillCurrent = true,
): void {
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  const handoff = {
    previousSharedDatabasePath: sourcePath,
    sharedDatabasePath: resolveSharedAuthStorePath(env),
    env,
    sourceStillCurrent,
  };
  for (const publish of freshSharedAuthStoreHandoffs) {
    publish(handoff);
  }
}

function initializeFreshSharedAuthStore(env: NodeJS.ProcessEnv, config?: OpenClawConfig): void {
  const ownership = prepareSharedAuthStoreOwnershipForNative(env);
  if (ownership.location === "state-db" || inspectedLegacySharedAuthOwnerships.has(ownership)) {
    return;
  }
  try {
    const selection = resolveLegacySharedAuthSourceSelection({
      config,
      env,
      ownershipLocation: ownership.location,
    });
    // Both stores hold inherited credentials. Leave each in place: copying either one
    // would change which credentials some peers read.
    if (selection.conflictingSourcePath) {
      inspectedLegacySharedAuthOwnerships.add(ownership);
      return;
    }
    if (listLegacyAuthProfileSources({ agentDir: selection.sourceDir, env }).length > 0) {
      inspectedLegacySharedAuthOwnerships.add(ownership);
      return;
    }
    const rows = inspectSharedAuthLegacyRowsReadOnly(selection.sourcePath);
    if (rows.store || rows.state || hasPendingSharedAuthCleanup(env, selection.sourcePath)) {
      inspectedLegacySharedAuthOwnerships.add(ownership);
      return;
    }
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
    publishFreshSharedAuthStoreHandoff(selection.sourcePath, env);
  } catch {
    // Doctor owns unreadable or partially migrated legacy state; never infer past it.
    inspectedLegacySharedAuthOwnerships.add(ownership);
  }
}

export function isSharedAuthProfileWrite(params: {
  agentDir: string | undefined;
  allowExplicitMain: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    params.agentDir === undefined ||
    (params.allowExplicitMain &&
      path.resolve(resolveUserPath(params.agentDir, params.env)) ===
        path.resolve(resolveSharedMainAuthAgentDir(params.env)))
  );
}

export function prepareFreshSharedAuthStoreWrite(params: {
  agentDir: string | undefined;
  allowExplicitMain: boolean;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
}): boolean {
  // A main-agent credential is shared; explicit main writes must follow the shared target.
  // On legacy roots both routes already resolve to the same file, so redirecting is a no-op.
  const isSharedWrite = isSharedAuthProfileWrite(params);
  if (isSharedWrite) {
    initializeFreshSharedAuthStore(params.env, params.config);
  }
  return isSharedWrite;
}
