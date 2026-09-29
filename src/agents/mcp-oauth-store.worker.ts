import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { ensureMcpOAuthPendingSchema } from "../state/openclaw-state-db-schema-additive.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import {
  readMcpOAuthStoreInDatabase,
  replaceMcpOAuthStoreInDatabase,
  MCP_OAUTH_PENDING_STATE_TTL_MS,
  type McpOAuthDatabase,
  type McpOAuthReadOperations,
} from "./mcp-oauth-store.kernel.js";
import { applyMcpOAuthMutation } from "./mcp-oauth-store.mutations.js";
import type { McpOAuthWriteOperations } from "./mcp-oauth-store.types.js";

type McpOAuthOwnedStore = McpOAuthWriteOperations["mcpOAuth.clear"]["input"];
type McpOAuthWorkerOperations = McpOAuthReadOperations & McpOAuthWriteOperations;

/** Select this feature's commands from the typed shared-state wire contract. */
export function isMcpOAuthWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<McpOAuthWorkerOperations> {
  switch (command.type) {
    case "mcpOAuth.read":
    case "mcpOAuth.mutate":
    case "mcpOAuth.consumePending":
    case "mcpOAuth.writePending":
    case "mcpOAuth.deletePending":
    case "mcpOAuth.clear":
    case "mcpOAuth.clearPendingPrefix":
      return true;
    default:
      return false;
  }
}

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

/** Keep feature reads and writes on the shared-state worker's retained database. */
export function executeMcpOAuthWorkerCommand(
  database: OpenClawStateDatabase,
  command: SqliteWorkerCommand<McpOAuthWorkerOperations>,
): McpOAuthWorkerOperations[keyof McpOAuthWorkerOperations]["output"] {
  if (command.type === "mcpOAuth.read") {
    return readMcpOAuthStoreInDatabase(database.db, command.input);
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const result = executeMcpOAuthWriteInTransaction(db, command);
      // The final grant can refuse a mutation and roll back the whole transaction.
      if (command.type === "mcpOAuth.clearPendingPrefix") {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      } else {
        assertStoreLease(db, command.input, "commit");
      }
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
  );
}

function executeMcpOAuthWriteInTransaction(
  database: DatabaseSync,
  command: SqliteWorkerCommand<McpOAuthWriteOperations>,
): McpOAuthWriteOperations[keyof McpOAuthWriteOperations]["output"] {
  const kysely = getNodeSqliteKysely<McpOAuthDatabase>(database);
  if (command.type === "mcpOAuth.clearPendingPrefix") {
    // Requester key grammar excludes SQL wildcards. This existing cleanup also removes
    // orphaned callback rows without inventing a per-store lease.
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    ensurePendingSchema(database);
    executeSqliteQuerySync(
      database,
      kysely
        .deleteFrom("mcp_oauth_pending_authorizations")
        .where("store_key", "like", `${command.input}%`),
    );
    return undefined;
  }
  const { storeKey } = command.input;
  const assertOwned = () => assertStoreLease(database, command.input);
  if (command.type === "mcpOAuth.mutate") {
    const result = applyMcpOAuthMutation(
      readMcpOAuthStoreInDatabase(database, storeKey),
      command.input.mutation,
    );
    replaceMcpOAuthStoreInDatabase(database, storeKey, result.store, assertOwned);
    return result;
  }
  assertOwned();
  ensurePendingSchema(database);
  const deletePending = () => {
    assertOwned();
    executeSqliteQuerySync(
      database,
      kysely.deleteFrom("mcp_oauth_pending_authorizations").where("store_key", "=", storeKey),
    );
  };
  switch (command.type) {
    case "mcpOAuth.consumePending":
      assertOwned();
      return (
        executeSqliteQuerySync(
          database,
          kysely
            .deleteFrom("mcp_oauth_pending_authorizations")
            .where("store_key", "=", storeKey)
            .where("state", "=", command.input.state)
            .where("create_time", ">", Date.now() - MCP_OAUTH_PENDING_STATE_TTL_MS),
        ).numAffectedRows === 1n
      );
    case "mcpOAuth.writePending": {
      const now = Date.now();
      assertOwned();
      executeSqliteQuerySync(
        database,
        kysely
          .deleteFrom("mcp_oauth_pending_authorizations")
          .where("create_time", "<=", now - MCP_OAUTH_PENDING_STATE_TTL_MS),
      );
      deletePending();
      assertOwned();
      executeSqliteQuerySync(
        database,
        kysely
          .insertInto("mcp_oauth_pending_authorizations")
          .values({ state: command.input.state, store_key: storeKey, create_time: now }),
      );
      return undefined;
    }
    case "mcpOAuth.deletePending":
      deletePending();
      return undefined;
    case "mcpOAuth.clear":
      // Doctor imports retired credentials only into an explicitly uninitialized row.
      replaceMcpOAuthStoreInDatabase(
        database,
        storeKey,
        { credentialState: "cleared" },
        assertOwned,
      );
      deletePending();
      return undefined;
  }
  void (command satisfies never);
  throw new Error("Unknown MCP OAuth write command");
}
