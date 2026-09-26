import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
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

describe("MCP OAuth worker reads", () => {
  it("prepares provider facts and reopens persisted reads without parent SQL", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-worker-read-" }, async () => {
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const operator = operatorMcpOAuthIdentity("worker-read", "https://mcp.example.test/rpc");
      const first = requesterMcpOAuthIdentity(operator.serverName, operator.serverUrl, {
        requesterSenderId: "first",
      });
      const second = requesterMcpOAuthIdentity(operator.serverName, operator.serverUrl, {
        requesterSenderId: "second",
      });
      const outside = requesterMcpOAuthIdentity("other-server", operator.serverUrl, {
        requesterSenderId: "first",
      });
      const prefix = requesterMcpOAuthStoreKeyPrefix(operator.serverName, operator.serverUrl);
      const store: McpOAuthStore = {
        clientInformation: { client_id: "fixture-client" },
        tokens: {
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
        },
        tokenExpiresAt: Date.now() + 3_600_000,
        tokensAuthorizationServerUrl: "https://issuer.example.test",
        codeVerifier: "fixture-verifier",
        discoveryState: { authorizationServerUrl: "https://issuer.example.test" },
        redirectUrl: "https://gateway.example.test/oauth/mcp/callback",
      };
      for (const identity of [first, second, outside]) {
        seedMcpOAuthStoreForTest(
          identity.storeKey,
          store,
          identity === first ? "fixture-pending-state" : undefined,
        );
      }
      await closeOpenClawStateDatabaseAsync();

      // Capability checks and native fixture writes precede the measured read lifecycle.
      const sql = {
        prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
        exec: vi.spyOn(DatabaseSync.prototype, "exec"),
        get: vi.spyOn(StatementSync.prototype, "get"),
        all: vi.spyOn(StatementSync.prototype, "all"),
        run: vi.spyOn(StatementSync.prototype, "run"),
        iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      };
      try {
        for (let pass = 0; pass < 2; pass++) {
          await withMcpOAuthProviderForTest(
            {
              identity: first,
              config: { scope: "documents.read" },
            },
            async (provider) => {
              expect(provider.redirectUrl).toBe(store.redirectUrl);
              expect(provider.clientMetadata).toMatchObject({
                redirect_uris: [store.redirectUrl],
                scope: "documents.read",
              });
              expect(await provider.clientInformation()).toEqual(store.clientInformation);
              expect(await provider.tokens()).toEqual(store.tokens);
              expect(await provider.codeVerifier()).toBe(store.codeVerifier);
              expect(await provider.discoveryState?.()).toEqual(store.discoveryState);
            },
          );
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
        expect(
          Object.fromEntries(
            Object.entries(sql).map(([name, spy]) => [name, spy.mock.calls.length]),
          ),
        ).toEqual({ prepare: 0, exec: 0, get: 0, all: 0, run: 0, iterate: 0 });
      } finally {
        try {
          await closeOpenClawStateDatabaseAsync();
        } finally {
          for (const spy of Object.values(sql)) {
            spy.mockRestore();
          }
        }
      }
    });
  });

  it("rejects a retired captured store instead of reopening it for a read", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-captured-read-" }, async () => {
      const identity = operatorMcpOAuthIdentity("retired-reader", "https://mcp.example.test/rpc");
      const context = captureOpenClawStateWorkerContext();
      await expect(fs.stat(context.admission.databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await closeOpenClawStateDatabaseAsync();
      await expect(readMcpOAuthStoreReadOnly(identity.storeKey, context)).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
      await expect(
        createMcpOAuthClientProvider({
          identity,
          storeContext: context,
          // Read admission must reject before any lease verification can create state.
          lease: {
            signal: new AbortController().signal,
            async assertOwned() {},
            async renew() {},
          },
        }),
      ).rejects.toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
      await expect(fs.stat(context.admission.databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps the legacy loopback redirect as the default for upgrade compatibility", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-default-redirect-" }, async () => {
      await withMcpOAuthProviderForTest(
        {
          identity: operatorMcpOAuthIdentity("Calendly", "https://mcp.calendly.com/"),
        },
        async (provider) => {
          expect(provider.clientMetadata.redirect_uris).toEqual([
            "http://127.0.0.1:8989/oauth/callback",
          ]);
          expect(provider.redirectUrl).toBe("http://127.0.0.1:8989/oauth/callback");
        },
      );
    });
  });
});
