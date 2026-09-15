// Canonical MCP OAuth session state. Legacy JSON import belongs to doctor only.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { ensureMcpOAuthPendingSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  projectMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "./mcp-oauth-status.js";
import {
  MCP_OAUTH_PENDING_STATE_TTL_MS,
  readMcpOAuthStoreInDatabase,
  replaceMcpOAuthStoreInDatabase,
  type McpOAuthDatabase,
} from "./mcp-oauth-store.kernel.js";
import type { McpOAuthStore } from "./mcp-oauth-store.types.js";
export { parseMcpOAuthStoreJson } from "./mcp-oauth-store.kernel.js";
export type { McpOAuthStore } from "./mcp-oauth-store.types.js";

const pendingSchemaDatabases = new WeakSet<DatabaseSync>();

/** Read canonical state, opening the writable lifecycle when runtime owns it. */
export async function readMcpOAuthStore(
  storeKey: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthStore> {
  return executeOpenClawStateWorker(context, { type: "mcpOAuth.read", input: storeKey });
}

/** Read status state without creating or repairing the shared database. */
export async function readMcpOAuthStoreReadOnly(
  storeKey: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthStore> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.readOnly", input: storeKey },
    { context },
  );
  if (result === undefined) {
    return {};
  }
  if (result.ok && result.type === "mcpOAuth.readOnly") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth store read result");
}

export async function readMcpOAuthStoreStatuses(
  storeKeys: readonly string[],
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthPrincipalStatus[]> {
  if (storeKeys.length === 0) {
    return [];
  }
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.statuses", input: storeKeys },
    { context },
  );
  if (result === undefined) {
    return storeKeys.map(() => projectMcpOAuthCredentialsStatus({}));
  }
  if (result.ok && result.type === "mcpOAuth.statuses") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth status batch result");
}

/** List canonical store keys matching one server/principal prefix without creating state. */
export async function listMcpOAuthStoreKeysByPrefix(
  prefix: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<string[]> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.keys", input: prefix },
    { context },
  );
  if (result === undefined) {
    return [];
  }
  if (result.ok && result.type === "mcpOAuth.keys") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth keys read result");
}

export async function countMcpOAuthStorePrincipals(prefix: string): Promise<number> {
  const context = captureOpenClawStateWorkerContext();
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.countPrincipals", input: prefix },
    { context },
  );
  if (result === undefined) {
    return 0;
  }
  if (result.ok && result.type === "mcpOAuth.countPrincipals") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth principal count result");
}

/** Resolve one unexpired callback state without creating state or scanning credential JSON. */
export async function readMcpOAuthPendingAuthorization(
  state: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<string | undefined> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.pending", input: state },
    { context },
  );
  if (result === undefined) {
    return undefined;
  }
  if (result.ok && result.type === "mcpOAuth.pending") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth pending state read result");
}

function ensurePendingSchema(database: DatabaseSync): void {
  if (pendingSchemaDatabases.has(database)) {
    return;
  }
  ensureMcpOAuthPendingSchema(database);
  pendingSchemaDatabases.add(database);
}

function runPendingWrite<T>(
  run: (database: DatabaseSync) => T,
  context?: OpenClawStateWorkerContext,
): T {
  context?.admission.assertCurrent();
  const options = context
    ? { path: context.admission.databasePath, env: context.environment }
    : undefined;
  ensurePendingSchema(openOpenClawStateDatabase(options).db);
  return runOpenClawStateWriteTransaction(({ db }) => {
    context?.admission.assertCurrent();
    return run(db);
  }, options);
}

function deletePendingForStore(
  database: DatabaseSync,
  storeKey: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
): void {
  assertOwnedInTransaction?.(database);
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .deleteFrom("mcp_oauth_pending_authorizations")
      .where("store_key", "=", storeKey),
  );
}

/** Claim one exact unexpired callback state while its store lease is still owned. */
export function consumeOAuthState(
  storeKey: string,
  state: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
  context?: OpenClawStateWorkerContext,
): boolean {
  return runPendingWrite((database) => {
    assertOwnedInTransaction?.(database);
    return (
      executeSqliteQuerySync(
        database,
        getNodeSqliteKysely<McpOAuthDatabase>(database)
          .deleteFrom("mcp_oauth_pending_authorizations")
          .where("store_key", "=", storeKey)
          .where("state", "=", state)
          // Expired rows are unclaimable; supersede/clear paths delete them.
          .where("create_time", ">", Date.now() - MCP_OAUTH_PENDING_STATE_TTL_MS),
      ).numAffectedRows === 1n
    );
  }, context);
}

/** Replace one store's pending callback state after OAuth persisted its session. */
export function writeMcpOAuthPendingAuthorization(
  storeKey: string,
  state: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
  context?: OpenClawStateWorkerContext,
): void {
  runPendingWrite((database) => {
    const now = Date.now();
    assertOwnedInTransaction?.(database);
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<McpOAuthDatabase>(database)
        .deleteFrom("mcp_oauth_pending_authorizations")
        .where("create_time", "<=", now - MCP_OAUTH_PENDING_STATE_TTL_MS),
    );
    deletePendingForStore(database, storeKey);
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<McpOAuthDatabase>(database)
        .insertInto("mcp_oauth_pending_authorizations")
        .values({ state, store_key: storeKey, create_time: now }),
    );
  }, context);
}

/** Delete callback correlation for one settled or cleared OAuth store. */
export function deleteMcpOAuthPendingAuthorization(
  storeKey: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
  context?: OpenClawStateWorkerContext,
): void {
  runPendingWrite((database) => {
    deletePendingForStore(database, storeKey, assertOwnedInTransaction);
  }, context);
}

/** Delete callback correlation for every requester store under one server key prefix. */
export function deleteMcpOAuthPendingAuthorizationsByPrefix(
  prefix: string,
  context?: OpenClawStateWorkerContext,
): void {
  runPendingWrite((database) => {
    // Requester store-key grammar excludes SQL wildcard bytes; changing it without
    // escaping here could clear unrelated principals.
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<McpOAuthDatabase>(database)
        .deleteFrom("mcp_oauth_pending_authorizations")
        .where("store_key", "like", `${prefix}%`),
    );
  }, context);
}

/** Atomically read, modify, and replace one OAuth session row. */
export function updateMcpOAuthStore(
  storeKey: string,
  update: (current: McpOAuthStore) => McpOAuthStore,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
  context?: OpenClawStateWorkerContext,
): McpOAuthStore {
  context?.admission.assertCurrent();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      context?.admission.assertCurrent();
      const current = readMcpOAuthStoreInDatabase(db, storeKey);
      return replaceMcpOAuthStoreInDatabase(
        db,
        storeKey,
        update(current),
        assertOwnedInTransaction,
      );
    },
    context ? { path: context.admission.databasePath, env: context.environment } : undefined,
  );
}

/** Clear one OAuth session while retaining an authoritative canonical row. */
export function clearMcpOAuthStore(
  storeKey: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
  context?: OpenClawStateWorkerContext,
): void {
  // Explicit provenance distinguishes logout from challenge-only bootstrap state.
  // Doctor imports retired credentials only into an `uninitialized` row.
  runPendingWrite((db) => {
    replaceMcpOAuthStoreInDatabase(
      db,
      storeKey,
      { credentialState: "cleared" },
      assertOwnedInTransaction,
    );
    deletePendingForStore(db, storeKey, assertOwnedInTransaction);
  }, context);
}
