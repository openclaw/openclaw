import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  clearMcpOAuthStore,
  consumeOAuthState,
  deleteMcpOAuthPendingAuthorizationsByPrefix,
  readMcpOAuthPendingAuthorization,
  writeMcpOAuthPendingAuthorization,
} from "./mcp-oauth-store.js";
import { withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

async function withTempHome(run: () => Promise<void>): Promise<void> {
  await withBaseTempHome(async () => {
    try {
      await run();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });
}

describe("MCP OAuth pending authorization store", () => {
  it("lazily creates durable exact-state correlation without changing schema version", async () => {
    await withTempHome(async () => {
      const database = openOpenClawStateDatabase().db;
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("mcp_oauth_pending_authorizations"),
      ).toBeUndefined();

      // Public callback lookups are read-only: an unknown state must not
      // create the lazy table or any shared state.
      expect(await readMcpOAuthPendingAuthorization("unknown-state")).toBeUndefined();
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("mcp_oauth_pending_authorizations"),
      ).toBeUndefined();

      const store = operatorMcpOAuthIdentity("Pending", "https://pending.example.com/mcp");
      await withMcpOAuthTestLease(
        store.storeKey,
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(store.storeKey, "first-state", lease, context),
      );
      expect(
        database
          .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
          .get("mcp_oauth_pending_authorizations"),
      ).toEqual({ strict: 1 });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(await readMcpOAuthPendingAuthorization("first-state")).toBe(store.storeKey);

      await withMcpOAuthTestLease(
        store.storeKey,
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(store.storeKey, "second-state", lease, context),
      );
      expect(await readMcpOAuthPendingAuthorization("first-state")).toBeUndefined();
      expect(await readMcpOAuthPendingAuthorization("second-state")).toBe(store.storeKey);
      expect(
        await withMcpOAuthTestLease(
          store.storeKey,
          async (lease, context) =>
            await consumeOAuthState(store.storeKey, "other-state", lease, context),
        ),
      ).toBe(false);
      expect(
        await withMcpOAuthTestLease(
          store.storeKey,
          async (lease, context) =>
            await consumeOAuthState(store.storeKey, "second-state", lease, context),
        ),
      ).toBe(true);
      expect(
        await withMcpOAuthTestLease(
          store.storeKey,
          async (lease, context) =>
            await consumeOAuthState(store.storeKey, "second-state", lease, context),
        ),
      ).toBe(false);

      await withMcpOAuthTestLease(
        store.storeKey,
        async (lease, context) => await clearMcpOAuthStore(store.storeKey, lease, context),
      );
      expect(await readMcpOAuthPendingAuthorization("second-state")).toBeUndefined();
    });
  });

  it("uses exact state lookup and clears one requester prefix", async () => {
    await withTempHome(async () => {
      const database = openOpenClawStateDatabase().db;
      await withMcpOAuthTestLease(
        "schema-install",
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(
            "schema-install",
            "schema-install-state",
            lease,
            context,
          ),
      );
      expect(
        await withMcpOAuthTestLease(
          "schema-install",
          async (lease, context) =>
            await consumeOAuthState("schema-install", "schema-install-state", lease, context),
        ),
      ).toBe(true);
      const insertPending = database.prepare(
        "INSERT INTO mcp_oauth_pending_authorizations (state, store_key, create_time) VALUES (?, ?, ?)",
      );
      const insertStore = database.prepare(
        "INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)",
      );
      database.exec("BEGIN");
      try {
        for (let index = 0; index < 1_000; index += 1) {
          insertPending.run(`seed-${index}`, `unrelated-${index}`, index);
          insertStore.run(
            `stored-${index}`,
            'invalid-json-with-"lastAuthorizationUrl"-marker',
            index,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      expect(await readMcpOAuthPendingAuthorization("absent-state")).toBeUndefined();

      // A copied sign-in link dies after the pending-state TTL, even unclaimed.
      insertPending.run("expired-state", "expired-store", Date.now() - 11 * 60 * 1000);
      insertPending.run("fresh-foreign-state", "fresh-foreign-store", Date.now());
      expect(await readMcpOAuthPendingAuthorization("expired-state")).toBeUndefined();
      expect(
        await withMcpOAuthTestLease(
          "expired-store",
          async (lease, context) =>
            await consumeOAuthState("expired-store", "expired-state", lease, context),
        ),
      ).toBe(false);

      await withMcpOAuthTestLease(
        "server-r-requester-a",
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(
            "server-r-requester-a",
            "requester-a-state",
            lease,
            context,
          ),
      );
      expect(
        database
          .prepare("SELECT state FROM mcp_oauth_pending_authorizations WHERE state = ?")
          .get("expired-state"),
      ).toBeUndefined();
      expect(await readMcpOAuthPendingAuthorization("fresh-foreign-state")).toBe(
        "fresh-foreign-store",
      );
      await withMcpOAuthTestLease(
        "server-r-requester-b",
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(
            "server-r-requester-b",
            "requester-b-state",
            lease,
            context,
          ),
      );
      await withMcpOAuthTestLease(
        "other-r-requester",
        async (lease, context) =>
          await writeMcpOAuthPendingAuthorization(
            "other-r-requester",
            "other-state",
            lease,
            context,
          ),
      );
      await deleteMcpOAuthPendingAuthorizationsByPrefix(
        "server-r-",
        captureOpenClawStateWorkerContext(),
      );

      expect(await readMcpOAuthPendingAuthorization("requester-a-state")).toBeUndefined();
      expect(await readMcpOAuthPendingAuthorization("requester-b-state")).toBeUndefined();
      expect(await readMcpOAuthPendingAuthorization("other-state")).toBe("other-r-requester");
    });
  });
});
