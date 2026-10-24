import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
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
  readMcpOAuthPendingAuthorization as readPending,
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

function writePending(storeKey: string, state: string) {
  return withMcpOAuthTestLease(storeKey, (lease, context) =>
    writeMcpOAuthPendingAuthorization({ storeKey, lease, context }, state),
  );
}

function consumePending(storeKey: string, state: string) {
  return withMcpOAuthTestLease(storeKey, (lease, context) =>
    consumeOAuthState({ storeKey, lease, context }, state),
  );
}

function pendingTable(database: ReturnType<typeof openOpenClawStateDatabase>["db"]) {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get("mcp_oauth_pending_authorizations");
}

describe("MCP OAuth pending authorization store", () => {
  it("rolls back first-use schema after refused grants and retries on the retained actor", async () => {
    await withTempHome(async () => {
      const database = openOpenClawStateDatabase().db;
      expect(pendingTable(database)).toBeUndefined();
      const store = operatorMcpOAuthIdentity("Pending grants", "https://pending.example.test/mcp");
      await withMcpOAuthTestLease(store.storeKey, async (lease, context) => {
        const options = { storeKey: store.storeKey, lease, context };
        for (const stage of ["transaction", "commit"] as const) {
          let current = true;
          let observedGrant = false;
          const refusal = new Error(`Synthetic pending authority retired at ${stage}`);
          const admission = probe.admission(workerAdmission, (request, grant, admit) => {
            const facts = request.facts;
            if (
              request.stage === stage &&
              isRecord(facts) &&
              facts.kind === "state-lease" &&
              isRecord(facts.identity) &&
              facts.identity.key === store.storeKey
            ) {
              // Dispatch has passed; retire authority at the actual grant port.
              current = false;
              observedGrant = true;
            }
            admit(request, grant);
          });
          try {
            await expect(
              writeMcpOAuthPendingAuthorization(options, `refused-${stage}`, {
                assertCurrent() {
                  if (!current) {
                    throw refusal;
                  }
                },
              }),
            ).rejects.toThrow(refusal.message);
          } finally {
            admission.mockRestore();
          }
          expect(observedGrant).toBe(true);
          expect(pendingTable(database)).toBeUndefined();
        }
        await writeMcpOAuthPendingAuthorization(options, "authorized-retry");
        expect(await readPending("authorized-retry", context)).toBe(store.storeKey);
        expect(pendingTable(database)).toEqual({ name: "mcp_oauth_pending_authorizations" });
      });
    });
  });

  it("lazily creates durable exact-state correlation without changing schema version", async () => {
    await withTempHome(async () => {
      const database = openOpenClawStateDatabase().db;
      expect(pendingTable(database)).toBeUndefined();

      // Public callback lookups are read-only: an unknown state must not
      // create the lazy table or any shared state.
      expect(await readPending("unknown-state")).toBeUndefined();
      expect(pendingTable(database)).toBeUndefined();

      const store = operatorMcpOAuthIdentity("Pending", "https://pending.example.com/mcp");
      await writePending(store.storeKey, "first-state");
      expect(
        database
          .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
          .get("mcp_oauth_pending_authorizations"),
      ).toEqual({ strict: 1 });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(await readPending("first-state")).toBe(store.storeKey);

      await writePending(store.storeKey, "second-state");
      expect(await readPending("first-state")).toBeUndefined();
      expect(await readPending("second-state")).toBe(store.storeKey);
      expect(await consumePending(store.storeKey, "other-state")).toBe(false);
      expect(await consumePending(store.storeKey, "second-state")).toBe(true);
      expect(await consumePending(store.storeKey, "second-state")).toBe(false);

      await withMcpOAuthTestLease(
        store.storeKey,
        async (lease, context) =>
          await clearMcpOAuthStore({ storeKey: store.storeKey, lease, context }),
      );
      expect(await readPending("second-state")).toBeUndefined();
    });
  });

  it("uses exact state lookup and clears one requester prefix", async () => {
    await withTempHome(async () => {
      const database = openOpenClawStateDatabase().db;
      await writePending("schema-install", "schema-install-state");
      expect(await consumePending("schema-install", "schema-install-state")).toBe(true);
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
      expect(await readPending("absent-state")).toBeUndefined();

      // A copied sign-in link dies after the pending-state TTL, even unclaimed.
      insertPending.run("expired-state", "expired-store", Date.now() - 11 * 60 * 1000);
      insertPending.run("fresh-foreign-state", "fresh-foreign-store", Date.now());
      expect(await readPending("expired-state")).toBeUndefined();
      expect(await consumePending("expired-store", "expired-state")).toBe(false);

      await writePending("server-r-requester-a", "requester-a-state");
      expect(
        database
          .prepare("SELECT state FROM mcp_oauth_pending_authorizations WHERE state = ?")
          .get("expired-state"),
      ).toBeUndefined();
      expect(await readPending("fresh-foreign-state")).toBe("fresh-foreign-store");
      await writePending("server-r-requester-b", "requester-b-state");
      await writePending("other-r-requester", "other-state");
      await deleteMcpOAuthPendingAuthorizationsByPrefix(
        "server-r-",
        captureOpenClawStateWorkerContext(),
      );

      expect(await readPending("requester-a-state")).toBeUndefined();
      expect(await readPending("requester-b-state")).toBeUndefined();
      expect(await readPending("other-state")).toBe("other-r-requester");
    });
  });
});
