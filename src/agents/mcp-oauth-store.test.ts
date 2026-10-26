import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  consumeOAuthState,
  deleteMcpOAuthPendingAuthorizationsByPrefix,
  readMcpOAuthPendingAuthorization as readPending,
  writeMcpOAuthPendingAuthorization,
} from "./mcp-oauth-store.js";
import { withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

const pendingTableName = "mcp_oauth_pending_authorizations";

function withTempHome(run: () => Promise<void>) {
  return withBaseTempHome(async () => {
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

function row(sql: string, ...params: string[]) {
  return openOpenClawStateDatabase()
    .db.prepare(sql)
    .get(...params);
}
const pendingTable = () =>
  row("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", pendingTableName);

it("rolls back first-use schema after refused grants and retries on the retained actor", () =>
  withTempHome(async () => {
    expect(pendingTable()).toBeUndefined();
    const storeKey = "pending-grants";
    await withMcpOAuthTestLease(storeKey, async (lease, context) => {
      const options = { storeKey, lease, context };
      for (const stage of ["transaction", "commit"] as const) {
        let current = true;
        const refusal = new Error(`Synthetic pending authority retired at ${stage}`);
        const admission = probe.admission(workerAdmission, (request, grant, admit) => {
          const facts = request.facts;
          if (
            request.stage === stage &&
            isRecord(facts) &&
            facts.kind === "state-lease" &&
            isRecord(facts.identity) &&
            facts.identity.key === storeKey
          ) {
            // Dispatch has passed; retire authority at the actual grant port.
            current = false;
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
        expect(pendingTable()).toBeUndefined();
      }
      await writeMcpOAuthPendingAuthorization(options, "authorized-retry");
      expect(await readPending("authorized-retry", context)).toBe(storeKey);
      expect(pendingTable()).toEqual({ name: pendingTableName });
    });
  }));

it("lazily creates durable exact-state correlation without changing schema version", () =>
  withTempHome(async () => {
    expect(pendingTable()).toBeUndefined();

    expect(await readPending("unknown-state")).toBeUndefined();
    expect(pendingTable()).toBeUndefined();

    const storeKey = "pending";
    await writePending(storeKey, "first-state");
    expect(row("SELECT strict FROM pragma_table_list WHERE name = ?", pendingTableName)).toEqual({
      strict: 1,
    });
    expect(row("PRAGMA user_version")).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(await readPending("first-state")).toBe(storeKey);

    await writePending(storeKey, "second-state");
    expect(await readPending("first-state")).toBeUndefined();
    expect(await readPending("second-state")).toBe(storeKey);
    expect(await consumePending(storeKey, "other-state")).toBe(false);
    expect(await consumePending(storeKey, "second-state")).toBe(true);
    expect(await consumePending(storeKey, "second-state")).toBe(false);
  }));

it("uses exact state lookup and clears one requester prefix", () =>
  withTempHome(async () => {
    const database = openOpenClawStateDatabase().db;
    await writePending("schema-install", "schema-install-state");
    expect(await consumePending("schema-install", "schema-install-state")).toBe(true);
    const insertPending = database.prepare(
      `INSERT INTO ${pendingTableName} (state, store_key, create_time) VALUES (?, ?, ?)`,
    );
    insertPending.run("unrelated-state", "unrelated-store", Date.now());
    // Exact lookup must not parse unrelated credential JSON.
    database
      .prepare(
        "INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)",
      )
      .run("unrelated-store", 'invalid-json-with-"lastAuthorizationUrl"-marker', Date.now());
    expect(await readPending("absent-state")).toBeUndefined();

    // A copied sign-in link dies after the pending-state TTL, even unclaimed.
    insertPending.run("expired-state", "expired-store", Date.now() - 11 * 60 * 1000);
    insertPending.run("fresh-foreign-state", "fresh-foreign-store", Date.now());
    expect(await readPending("expired-state")).toBeUndefined();
    expect(await consumePending("expired-store", "expired-state")).toBe(false);

    await writePending("server-r-requester-a", "requester-a-state");
    expect(
      row(`SELECT state FROM ${pendingTableName} WHERE state = ?`, "expired-state"),
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
  }));
