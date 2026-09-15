import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
} from "./mcp-oauth-identity.js";
import {
  listMcpOAuthStoreKeysByPrefix,
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";
import { countMcpOAuthPrincipals, readMcpOAuthCredentialsStatus } from "./mcp-oauth.js";
import { seedMcpOAuthStoreForTest, withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

const REMOTE_IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");

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
        close: vi.spyOn(DatabaseSync.prototype, "close"),
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
        ).toEqual({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0 });
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

  it("does not create shared state for a read-only credential status check", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-status-" }, async () => {
      const identity = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
      await expect(readMcpOAuthCredentialsStatus(identity)).resolves.toEqual({
        state: "unauthenticated",
      });
      await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
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
  it("stores token state only in shared SQLite with restricted permissions", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-" }, async ({ home }) => {
      await withMcpOAuthProviderForTest(
        {
          identity: REMOTE_IDENTITY,
        },
        async (provider) => {
          await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

          expect(await provider.tokens()).toEqual({
            access_token: "access",
            token_type: "Bearer",
          });
        },
      );

      const databasePath = resolveOpenClawStateSqlitePath();
      const rows = openOpenClawStateDatabase()
        .db.prepare("SELECT store_key, format_version FROM mcp_oauth_stores")
        .all();
      expect(rows).toEqual([
        { store_key: expect.stringMatching(/^Remote-Docs-[a-f0-9]{16}$/), format_version: 1 },
      ]);
      await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const stat = await fs.stat(databasePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  it("updates provider fields atomically and clears token expiry on invalidation", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-oauth-atomic-fields-" }, async () => {
      await withMcpOAuthProviderForTest(
        {
          identity: REMOTE_IDENTITY,
          allowAuthorizationRedirect: true,
        },
        async (provider) => {
          await provider.saveClientInformation?.({ client_id: "client-id" });
          await provider.saveTokens({
            access_token: "access",
            refresh_token: "refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
          await provider.saveCodeVerifier("verifier");
          await provider.invalidateCredentials?.("tokens");
        },
      );

      const store = await readMcpOAuthStore(REMOTE_IDENTITY.storeKey);
      expect(store.clientInformation).toEqual({ client_id: "client-id" });
      expect(store.codeVerifier).toBe("verifier");
      expect(store.tokens).toBeUndefined();
      expect(store.tokenExpiresAt).toBeUndefined();
      expect(store.credentialState).toBe("cleared");
    });
  });
});
