import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { COPILOT_INTEGRATION_ID, buildCopilotIdeHeaders } from "./copilot-dynamic-headers.js";
import {
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

async function withCopilotState<T>(
  run: (params: { env: NodeJS.ProcessEnv; stateDir: string }) => Promise<T>,
): Promise<T> {
  return await withTempDir("openclaw-copilot-token-", async (stateDir) => {
    return await run({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stateDir,
    });
  });
}

describe("resolveCopilotApiToken", () => {
  it("derives native Copilot base URLs from Copilot proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken(
        "copilot-token;proxy-ep=https://proxy.individual.githubcopilot.com;",
      ),
    ).toBe("https://api.individual.githubcopilot.com");
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com:8443;")).toBe(
      "https://api.example.com",
    );
  });

  it("rejects malformed or non-http proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
  });

  it("treats 11-digit expires_at values as seconds epochs", async () => {
    await withCopilotState(async ({ env }) => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          token: "copilot-token",
          expires_at: 12_345_678_901,
        }),
      }));

      const result = await resolveCopilotApiToken({
        githubToken: "github-token",
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.expiresAt).toBe(12_345_678_901_000);
    });
  });

  it("sends IDE and integration headers when exchanging the GitHub token", async () => {
    await withCopilotState(async ({ env }) => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          token: "copilot-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      }));

      await resolveCopilotApiToken({
        githubToken: "github-token",
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
      expect(init.method).toBe("GET");
      expect(init.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer github-token",
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        ...buildCopilotIdeHeaders({ includeApiVersion: true }),
      });
    });
  });

  it("caches exchanged tokens in SQLite state", async () => {
    await withCopilotState(async ({ env, stateDir }) => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          token: "copilot-token;proxy-ep=proxy.example.com;",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      }));

      const first = await resolveCopilotApiToken({
        githubToken: "github-token",
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const second = await resolveCopilotApiToken({
        githubToken: "github-token",
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(first.source).toBe("fetched:https://api.github.com/copilot_internal/v2/token");
      expect(second.source).toBe(
        "cache:sqlite:plugin_state_entries/github-copilot/token-cache/default",
      );
      expect(second.baseUrl).toBe("https://api.example.com");
      const stateDatabase = openOpenClawStateDatabase({ env });
      const stateDb = getNodeSqliteKysely<
        Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">
      >(stateDatabase.db);
      const cacheRow = executeSqliteQueryTakeFirstSync(
        stateDatabase.db,
        stateDb
          .selectFrom("plugin_state_entries")
          .select(["plugin_id", "namespace", "entry_key", "value_json"])
          .where("plugin_id", "=", "github-copilot")
          .where("namespace", "=", "token-cache")
          .where("entry_key", "=", "default"),
      );
      expect(cacheRow).toMatchObject({
        plugin_id: "github-copilot",
        namespace: "token-cache",
        entry_key: "default",
      });
      expect(JSON.parse(cacheRow?.value_json ?? "{}")).toMatchObject({
        token: "copilot-token;proxy-ep=proxy.example.com;",
        integrationId: COPILOT_INTEGRATION_ID,
      });
      expect(
        stateDatabase.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name = 'github_copilot_token_cache'`,
          )
          .get(),
      ).toBeUndefined();
      expect(fs.existsSync(path.join(stateDir, "credentials", "github-copilot.token.json"))).toBe(
        false,
      );
    });
  });
});
