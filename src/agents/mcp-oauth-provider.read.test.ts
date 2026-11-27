import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
} from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import {
  listMcpOAuthStoreKeysByPrefix,
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";
import { countMcpOAuthPrincipals } from "./mcp-oauth.js";
import { seedMcpOAuthStoreForTest, withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

const serverUrl = "https://mcp.example.test/rpc";
const defaultRedirect = "http://127.0.0.1:8989/oauth/callback";
const retiredRead = { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" };

function requester(requesterSenderId: string, serverName = "worker-read") {
  return requesterMcpOAuthIdentity(serverName, serverUrl, { requesterSenderId });
}

it("uses the legacy default and only ignores ports for HTTP loopback registrations", async () => {
  await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-registered-redirect-" }, async () => {
    const identity = operatorMcpOAuthIdentity("redirects", serverUrl);
    const cases: [string, string | undefined, boolean][] = [
      [defaultRedirect, undefined, true],
      ["http://127.0.0.1:8989/callback", "http://127.0.0.1:8989/callback", true],
      ["http://127.0.0.1/oauth/callback", "http://127.0.0.1:8989/oauth/callback", true],
      ["http://[::1]/oauth/callback", "http://[::1]:8989/oauth/callback", true],
      ["http://localhost/oauth/callback", "http://localhost:8989/oauth/callback", true],
      ["http://localhost", "http://localhost:8989", true],
      ["http://LOCALHOST/callback", "http://LOCALHOST:80/callback", true],
      ["http://localhost/callback", "http://LOCALHOST:8989/callback", false],
      ["http://[::1]/callback", "http://[0:0:0:0:0:0:0:1]:8989/callback", false],
      ["http://127.0.0.1/callback", "http://127.0.0.1:8989/a/../callback", false],
      ["https://example.test:8989/callback", "https://example.test:8989/callback", true],
      ["https://example.test/callback", "https://example.test:8989/callback", false],
      ["http://example.test/callback", "http://example.test:8989/callback", false],
      ["https://localhost/callback", "https://localhost:8989/callback", false],
      ["http://localhost/callback", "http://127.0.0.1:8989/callback", false],
      ["http://127.0.0.1/callback", "http://127.0.0.1:8989/other", false],
      ["http://127.0.0.1/callback?a=1", "http://127.0.0.1:8989/callback?a=2", false],
      ["http://127.0.0.1/callback#one", "http://127.0.0.1:8989/callback#two", false],
      ["http://127.0.0.1/callback", "http://user@127.0.0.1:8989/callback", false],
      ["http://127.0.0.1:9000/callback", "http://127.0.0.1:8989/callback", false],
      ["invalid-url", "another-invalid-url", false],
    ];
    for (const [registered, redirectUrl, matches] of cases) {
      const clientInformation = { client_id: "fixture-client", redirect_uris: [registered] };
      seedMcpOAuthStoreForTest(identity.storeKey, { clientInformation });
      await withMcpOAuthProviderForTest(
        { identity, config: { redirectUrl, scope: "documents.read" } },
        async (provider) => {
          if (redirectUrl === undefined) {
            expect(provider).toMatchObject({
              redirectUrl: defaultRedirect,
              clientMetadata: { redirect_uris: [defaultRedirect], scope: "documents.read" },
            });
          }
          expect(await provider.clientInformation(), `${registered} -> ${redirectUrl}`).toEqual(
            matches ? clientInformation : undefined,
          );
        },
      );
    }
  });
});

it("reopens persisted reads without parent SQL", async () => {
  await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-worker-read-" }, async () => {
    requireNodeSqlite();
    const operator = operatorMcpOAuthIdentity("worker-read", serverUrl);
    const first = requester("first");
    const second = requester("second");
    const outside = requester("first", "other-server");
    const prefix = requesterMcpOAuthStoreKeyPrefix(operator.serverName, operator.serverUrl);
    const store: McpOAuthStore = {
      tokens: { access_token: "access", refresh_token: "refresh", token_type: "Bearer" },
    };
    for (const identity of [first, second, outside]) {
      seedMcpOAuthStoreForTest(
        identity.storeKey,
        store,
        identity === first ? "fixture-pending-state" : undefined,
      );
    }
    await closeOpenClawStateDatabaseAsync();

    const sql = observeMainThreadSql();
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(await readMcpOAuthStore(first.storeKey)).toEqual(store);
        expect(await readMcpOAuthStoreReadOnly(first.storeKey)).toEqual(store);
        expect(await listMcpOAuthStoreKeysByPrefix(prefix)).toEqual(
          [first.storeKey, second.storeKey].toSorted(),
        );
        expect(await readMcpOAuthPendingAuthorization("fixture-pending-state")).toBe(
          first.storeKey,
        );
        expect(await countMcpOAuthPrincipals(operator)).toBe(2);
        await closeOpenClawStateDatabaseAsync();
      }
      sql.expectIdle();
    } finally {
      try {
        await closeOpenClawStateDatabaseAsync();
      } finally {
        sql.restore();
      }
    }
  });
});

it("rejects a retired captured store instead of reopening it for a read", async () => {
  await withOpenClawTestState({ prefix: "openclaw-mcp-captured-read-" }, async () => {
    const identity = operatorMcpOAuthIdentity("retired-reader", serverUrl);
    const context = captureOpenClawStateWorkerContext();
    const absent = () =>
      expect(fs.stat(context.admission.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await absent();
    await closeOpenClawStateDatabaseAsync();
    await expect(readMcpOAuthStoreReadOnly(identity.storeKey, context)).rejects.toMatchObject(
      retiredRead,
    );
    await expect(
      createMcpOAuthClientProvider({
        identity,
        storeContext: context,
        // Read admission must reject before any lease verification can create state.
        lease: {
          signal: new AbortController().signal,
          assertCurrent() {},
          async assertOwned() {},
          async renew() {},
        },
      }),
    ).rejects.toMatchObject(retiredRead);
    await absent();
  });
});
