import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
  type McpOAuthIdentity,
} from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import { listMcpOAuthStoreKeysByPrefix } from "./mcp-oauth-store.js";
import {
  clearMcpOAuthServer,
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  resolveMcpOAuthAccessToken,
} from "./mcp-oauth.js";
import { requesterIdentity, withTempHome } from "./mcp-oauth.test-harness.js";

const authMock = vi.hoisted(() => vi.fn());
const REMOTE_IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

async function saveAccessToken(identity: McpOAuthIdentity, accessToken: string): Promise<void> {
  const provider = await createMcpOAuthClientProvider({ identity });
  await provider.saveTokens({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
  });
}

describe("MCP OAuth requester credentials", () => {
  beforeEach(async () => {
    authMock.mockReset();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("fails closed when canonical SQLite JSON is malformed", async () => {
    await withTempHome(
      async () => {
        const identity = requesterIdentity(
          REMOTE_IDENTITY.serverName,
          REMOTE_IDENTITY.serverUrl,
          "alice",
        );
        const provider = await createMcpOAuthClientProvider({ identity });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
        const storeKey = identity.storeKey;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE mcp_oauth_stores SET store_json = ? WHERE store_key = ?")
          .run("{", storeKey);

        await expect(provider.tokens()).rejects.toThrow("store_json is not valid JSON");
        await expect(countMcpOAuthPrincipals(REMOTE_IDENTITY)).rejects.toThrow(
          `MCP OAuth store ${storeKey} is invalid: store_json is not valid JSON`,
        );
      },
      {
        prefix: "openclaw-mcp-oauth-corrupt-row-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("isolates, counts, and clears requester credentials by configured server", async () => {
    await withTempHome(
      async () => {
        const serverName = "Shared_Team";
        const serverUrl = "https://mcp.example.com/shared";
        const operator = operatorMcpOAuthIdentity(serverName, serverUrl);
        const alice = requesterIdentity(serverName, serverUrl, "alice");
        const bob = requesterIdentity(serverName, serverUrl, "bob");
        const other = requesterIdentity(serverName, "https://other.example.com/mcp", "alice");
        await saveAccessToken(alice, "alice-token");
        await saveAccessToken(bob, "bob-token");
        await saveAccessToken(other, "other-token");
        const prefix = requesterMcpOAuthStoreKeyPrefix(serverName, serverUrl);
        const unrelatedKeys = [
          ...Array.from({ length: 64 }, (_, index) => `unrelated-${index}`),
          `${prefix.toLowerCase()}case-neighbor`,
          `${prefix.replace("_", "X")}underscore-neighbor`,
        ];
        const insert = openOpenClawStateDatabase().db.prepare(
          "INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, 0)",
        );
        for (const key of unrelatedKeys) {
          insert.run(key, "{");
        }

        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await expect(resolveMcpOAuthAccessToken({ identity: alice })).resolves.toBe("alice-token");
        await expect(resolveMcpOAuthAccessToken({ identity: bob })).resolves.toBe("bob-token");
        expect(alice.storeKey).not.toBe(bob.storeKey);
        expect(await listMcpOAuthStoreKeysByPrefix(prefix)).toEqual(
          [alice.storeKey, bob.storeKey].toSorted(),
        );
        expect(await countMcpOAuthPrincipals(operator)).toBe(2);
        await clearMcpOAuthServer(operator);
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        for (const identity of [alice, bob]) {
          await expect(readMcpOAuthCredentialsStatus(identity)).resolves.toEqual({
            state: "unauthenticated",
          });
        }
        await expect(resolveMcpOAuthAccessToken({ identity: other })).resolves.toBe("other-token");
        expect(
          openOpenClawStateDatabase()
            .db.prepare(
              "SELECT store_key FROM mcp_oauth_stores WHERE store_json = ? ORDER BY store_key",
            )
            .all("{"),
        ).toEqual(unrelatedKeys.toSorted().map((store_key) => ({ store_key })));
      },
      {
        prefix: "openclaw-mcp-oauth-requesters-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });
});
