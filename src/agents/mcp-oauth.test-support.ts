import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureMcpOAuthPendingSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";
import { replaceMcpOAuthStoreInDatabase, type McpOAuthDatabase } from "./mcp-oauth-store.kernel.js";

/** Complete synthetic fixture records; never used while a test producer is running. */
export function seedMcpOAuthStoreForTest(
  storeKey: string,
  store: McpOAuthStore,
  pendingState?: string,
): void {
  const database = openOpenClawStateDatabase();
  if (pendingState !== undefined) {
    ensureMcpOAuthPendingSchema(database.db);
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      replaceMcpOAuthStoreInDatabase(db, storeKey, store);
      if (pendingState !== undefined) {
        const kysely = getNodeSqliteKysely<McpOAuthDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("mcp_oauth_pending_authorizations").where("store_key", "=", storeKey),
        );
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("mcp_oauth_pending_authorizations")
            .values({ state: pendingState, store_key: storeKey, create_time: Date.now() }),
        );
      }
    },
    { database },
  );
}

export function withMcpOAuthTestLease<T>(
  storeKey: string,
  run: (lease: OpenClawStateAsyncLeaseContext, context: OpenClawStateWorkerContext) => Promise<T>,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext();
  return withOpenClawStateLeaseAsync(
    { scope: "core:mcp-oauth", key: storeKey, leaseMs: 60_000, waitMs: 30_000 },
    context,
    (lease) => run(lease, context),
  );
}

/** A provider never escapes the callback that retains its real store lease. */
export function withMcpOAuthProviderForTest<T>(
  params: Omit<Parameters<typeof createMcpOAuthClientProvider>[0], "lease" | "storeContext">,
  run: (provider: OAuthClientProvider) => Promise<T>,
): Promise<T> {
  return withMcpOAuthTestLease(params.identity.storeKey, async (lease, storeContext) => {
    const provider = await createMcpOAuthClientProvider({ ...params, lease, storeContext });
    return await run(provider);
  });
}
