import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";
import { seedMcpOAuthStoreForTest } from "./mcp-oauth.test-support.js";

const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
const requesterScope = {
  requesterSenderId: "fixture-requester",
  messageChannel: "telegram",
  agentAccountId: "fixture-bot",
};
const publicOrigin = "https://gateway.example.test";
const url = (name: string) => `https://${name}.example.test/mcp`;
const server = (name: string) => ({
  url: url(name),
  transport: "streamable-http" as const,
  auth: "oauth" as const,
  oauth: { identity: "per-requester" as const },
});
const authorized = (extra: Partial<McpOAuthStore> = {}): McpOAuthStore => ({
  tokens: { access_token: "fixture", token_type: "Bearer" },
  ...extra,
});

it("prepares a sorted mixed-status catalog with one read and no parent SQL", async () => {
  await withOpenClawTestState({ prefix: "openclaw-mcp-requester-read-batch-" }, async () => {
    requireNodeSqlite();
    const mcpServers = Object.fromEntries(names.map((name) => [name, server(name)]));
    const stores: Record<string, McpOAuthStore> = {
      alpha: authorized(),
      bravo: authorized({ tokenExpiresAt: 1 }),
      charlie: authorized({ pendingAuthorizationChallenge: { requiresAuthorization: true } }),
      delta: { clientInformation: { client_id: "fixture-client" } },
      echo: { credentialState: "cleared" },
    };
    for (const [name, store] of Object.entries(stores)) {
      const identity = requesterMcpOAuthIdentity(name, url(name), requesterScope);
      seedMcpOAuthStoreForTest(identity.storeKey, store);
    }
    await closeOpenClawStateDatabaseAsync();

    // Synthetic seed writes and SQLite capability preflight precede the measured caller.
    const sql = observeMainThreadSql();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    try {
      const connected = await createRequesterMcpConnect({
        serverNames: new Set(["foxtrot", "delta", "alpha", "echo", "charlie", "bravo"]),
        mcpServers,
        safeServerNamesByServer: new Map(names.map((name) => [name, `safe_${name}`])),
        requesterScope,
        cfg: { gateway: { publicOrigin } },
        configFingerprint: "fixture-config",
      });
      await closeOpenClawStateDatabaseAsync();

      assert(connected, "Expected requester connect catalog");
      expect(Object.keys(connected.catalog.servers)).toEqual(names);
      expect(connected.catalog.tools).toMatchObject(
        names.map((name) => ({
          serverName: name,
          safeServerName: `safe_${name}`,
          toolName: "connect",
          oauthConnectBootstrap: true,
        })),
      );
      expect(connected.authorizedServerNames).toEqual(["alpha", "bravo"]);
      expect(JSON.parse(connected.configFingerprint)).toEqual({
        config: "fixture-config",
        authorizedServerNames: ["alpha", "bravo"],
        publicOrigin,
      });
      sql.expectIdle();
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
      sql.restore();
    }
  });
});
