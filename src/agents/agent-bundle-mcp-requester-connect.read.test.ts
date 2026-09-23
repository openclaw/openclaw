import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
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

describe("requester MCP status read batching", () => {
  it("prepares a sorted mixed-status catalog with one read and no parent SQL", async () => {
    await withOpenClawTestState({ prefix: "openclaw-mcp-requester-read-batch-" }, async () => {
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const mcpServers = Object.fromEntries(
        names.map((name) => [
          name,
          {
            url: `https://${name}.example.test/mcp`,
            transport: "streamable-http" as const,
            auth: "oauth" as const,
            oauth: { identity: "per-requester" as const },
          },
        ]),
      );
      const stores: Record<string, McpOAuthStore> = {
        alpha: { tokens: { access_token: "fixture-alpha", token_type: "Bearer" } },
        bravo: {
          tokens: { access_token: "fixture-bravo", token_type: "Bearer" },
          tokenExpiresAt: 1,
        },
        charlie: {
          tokens: { access_token: "fixture-charlie", token_type: "Bearer" },
          pendingAuthorizationChallenge: { requiresAuthorization: true },
        },
        delta: { clientInformation: { client_id: "fixture-client" } },
        echo: { credentialState: "cleared" },
      };
      for (const [name, store] of Object.entries(stores)) {
        const identity = requesterMcpOAuthIdentity(
          name,
          `https://${name}.example.test/mcp`,
          requesterScope,
        );
        seedMcpOAuthStoreForTest(identity.storeKey, store);
      }
      await closeOpenClawStateDatabaseAsync();

      // Synthetic seed writes and SQLite capability preflight precede the measured caller.
      const sql = {
        prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
        exec: vi.spyOn(DatabaseSync.prototype, "exec"),
        get: vi.spyOn(StatementSync.prototype, "get"),
        all: vi.spyOn(StatementSync.prototype, "all"),
        run: vi.spyOn(StatementSync.prototype, "run"),
        iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      };
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      try {
        const started = performance.now();
        const connected = await createRequesterMcpConnect({
          serverNames: new Set(["foxtrot", "delta", "alpha", "echo", "charlie", "bravo"]),
          mcpServers,
          safeServerNamesByServer: new Map(names.map((name) => [name, `safe_${name}`])),
          requesterScope,
          cfg: { gateway: { publicOrigin } },
          configFingerprint: "fixture-config",
        });
        await closeOpenClawStateDatabaseAsync();
        const elapsedMs = performance.now() - started;

        if (!connected) {
          throw new Error("Expected requester connect catalog");
        }
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
        expect(
          Object.fromEntries(
            Object.entries(sql).map(([name, spy]) => [name, spy.mock.calls.length]),
          ),
        ).toEqual({ prepare: 0, exec: 0, get: 0, all: 0, run: 0, iterate: 0 });
        console.info("MCP_REQUESTER_READ_TIMING", {
          servers: names.length,
          commonReads: reads.mock.calls.length,
          elapsedMs,
        });
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        try {
          await closeOpenClawStateDatabaseAsync();
        } finally {
          reads.mockRestore();
          for (const spy of Object.values(sql)) {
            spy.mockRestore();
          }
        }
      }
    });
  });
});
