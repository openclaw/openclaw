import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { ensureMcpOAuthPendingSchema } from "../state/openclaw-state-db-schema-additive.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  readMcpOAuthStoreInDatabase,
  replaceMcpOAuthStoreInDatabase,
  MCP_OAUTH_PENDING_STATE_TTL_MS,
  type McpOAuthDatabase,
} from "./mcp-oauth-store.kernel.js";
import { applyMcpOAuthMutation } from "./mcp-oauth-store.mutations.js";
import type { McpOAuthMutation } from "./mcp-oauth-store.types.js";

type McpOAuthOwnedStore = { storeKey: string; identity: OpenClawStateLeaseIdentity };

function assertStoreLease(
  database: DatabaseSync,
  input: McpOAuthOwnedStore,
  stage: "transaction" | "commit" = "transaction",
): void {
  if (input.identity.scope !== "core:mcp-oauth" || input.identity.key !== input.storeKey) {
    throw new Error("MCP OAuth mutation requires its exact store lease");
  }
  assertOpenClawStateLeaseWorkerOwnedInTransaction(database, input.identity, "write", stage);
}

const pendingSchemaDatabases = new WeakSet<DatabaseSync>();

function ensurePendingSchema(database: DatabaseSync): void {
  if (pendingSchemaDatabases.has(database)) {
    return;
  }
  ensureMcpOAuthPendingSchema(database);
  // First-use DDL and its cache entry share the outer transaction's outcome.
  deferSqlitePostCommitPublication(database, () => pendingSchemaDatabases.add(database));
}

function ownedWrite<Input extends McpOAuthOwnedStore, Result>(
  operation: (database: DatabaseSync, input: Input, assertOwned: () => void) => Result,
  pending = false,
) {
  return (input: Input, { open }: WorkerOperationContext): Result => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const assertOwned = () => assertStoreLease(db, input);
        if (pending) {
          assertOwned();
          ensurePendingSchema(db);
        }
        const result = operation(db, input, assertOwned);
        // The final grant can refuse a mutation and roll back the whole transaction.
        assertStoreLease(db, input, "commit");
        return result;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    );
  };
}

function deletePending(database: DatabaseSync, storeKey: string, assertOwned: () => void): void {
  assertOwned();
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .deleteFrom("mcp_oauth_pending_authorizations")
      .where("store_key", "=", storeKey),
  );
}

export const mcpOAuthOperations = {
  "mcpOAuth.read": (input: string, { open }) => readMcpOAuthStoreInDatabase(open().db, input),
  "mcpOAuth.mutate": ownedWrite(
    (database, input: McpOAuthOwnedStore & { mutation: McpOAuthMutation }, assertOwned) => {
      const result = applyMcpOAuthMutation(
        readMcpOAuthStoreInDatabase(database, input.storeKey),
        input.mutation,
      );
      replaceMcpOAuthStoreInDatabase(database, input.storeKey, result.store, assertOwned);
      return result;
    },
  ),
  "mcpOAuth.consumePending": ownedWrite(
    (database, input: McpOAuthOwnedStore & { state: string }, assertOwned) => {
      assertOwned();
      return (
        executeSqliteQuerySync(
          database,
          getNodeSqliteKysely<McpOAuthDatabase>(database)
            .deleteFrom("mcp_oauth_pending_authorizations")
            .where("store_key", "=", input.storeKey)
            .where("state", "=", input.state)
            .where("create_time", ">", Date.now() - MCP_OAUTH_PENDING_STATE_TTL_MS),
        ).numAffectedRows === 1n
      );
    },
    true,
  ),
  "mcpOAuth.writePending": ownedWrite(
    (database, input: McpOAuthOwnedStore & { state: string }, assertOwned): void => {
      const kysely = getNodeSqliteKysely<McpOAuthDatabase>(database);
      const now = Date.now();
      assertOwned();
      executeSqliteQuerySync(
        database,
        kysely
          .deleteFrom("mcp_oauth_pending_authorizations")
          .where("create_time", "<=", now - MCP_OAUTH_PENDING_STATE_TTL_MS),
      );
      deletePending(database, input.storeKey, assertOwned);
      assertOwned();
      executeSqliteQuerySync(
        database,
        kysely
          .insertInto("mcp_oauth_pending_authorizations")
          .values({ state: input.state, store_key: input.storeKey, create_time: now }),
      );
    },
    true,
  ),
  "mcpOAuth.deletePending": ownedWrite(
    (database, input: McpOAuthOwnedStore, assertOwned) =>
      deletePending(database, input.storeKey, assertOwned),
    true,
  ),
  "mcpOAuth.clear": ownedWrite((database, input: McpOAuthOwnedStore, assertOwned): void => {
    // Doctor imports retired credentials only into an explicitly uninitialized row.
    replaceMcpOAuthStoreInDatabase(
      database,
      input.storeKey,
      { credentialState: "cleared" },
      assertOwned,
    );
    deletePending(database, input.storeKey, assertOwned);
  }, true),
  "mcpOAuth.clearPendingPrefix": (input: string, { open }): void => {
    const database = open();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        // Requester key grammar excludes SQL wildcards; cleanup includes orphaned callbacks.
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        ensurePendingSchema(db);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<McpOAuthDatabase>(db)
            .deleteFrom("mcp_oauth_pending_authorizations")
            .where("store_key", "like", `${input}%`),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    );
  },
} satisfies WorkerOperationHandlers;

export type McpOAuthWorkerOperations = WorkerOperations<typeof mcpOAuthOperations>;
