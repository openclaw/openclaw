import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
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
} from "./mcp-oauth-store.kernel.js";
import { applyMcpOAuthMutation } from "./mcp-oauth-store.mutations.js";
import type { McpOAuthWriteOperations } from "./mcp-oauth-store.types.js";

type McpOAuthOwnedStore = McpOAuthWriteOperations["mcpOAuth.clear"]["input"];

function assertStoreLease(database: DatabaseSync, input: McpOAuthOwnedStore): void {
  if (input.identity.scope !== "core:mcp-oauth" || input.identity.key !== input.storeKey) {
    throw new Error("MCP OAuth mutation requires its exact store lease");
  }
  assertOpenClawStateLeaseWorkerOwnedInTransaction(database, input.identity);
}

const pendingSchemaDatabases = new WeakSet<DatabaseSync>();

/** Preserve the pending schema's first-use boundary before its write transaction. */
export function executeMcpOAuthWriteCommand(
  database: OpenClawStateDatabase,
  command: SqliteWorkerCommand<McpOAuthWriteOperations>,
): McpOAuthWriteOperations[keyof McpOAuthWriteOperations]["output"] {
  if (command.type !== "mcpOAuth.mutate" && !pendingSchemaDatabases.has(database.db)) {
    ensureMcpOAuthPendingSchema(database.db);
    pendingSchemaDatabases.add(database.db);
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => executeMcpOAuthWriteInTransaction(db, command),
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
