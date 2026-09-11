// Memory Core tests prove the chunking upgrade fallback against a real HTTP
// embedding server: the outage reaches the wire through the real
// openai-compatible provider, the real embedding retry policy, and the real
// SQLite store instead of a test-double provider.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./memory/manager.js";
import { isolateMemoryManagerTestConfig } from "./memory/test-config-helpers.js";
import "./memory/test-runtime-mocks.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";
import { createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

type ServerMode = "ok" | "unauthorized" | "quota";

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  status: number;
  body: Record<string, unknown>;
};

type EmbeddingServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  setMode: (mode: ServerMode) => void;
  close: () => Promise<void>;
};

const servers: EmbeddingServer[] = [];

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function errorBody(mode: Exclude<ServerMode, "ok">): Record<string, unknown> {
  return mode === "quota"
    ? {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }
    : {
        error: {
          message: "Invalid API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      };
}

async function startEmbeddingServer(): Promise<EmbeddingServer> {
  const requests: CapturedRequest[] = [];
  let mode: ServerMode = "ok";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        if (mode !== "ok") {
          const status = mode === "quota" ? 429 : 401;
          requests.push({ method: req.method, url: req.url, status, body });
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(errorBody(mode)));
          return;
        }
        requests.push({ method: req.method, url: req.url, status: 200, body });
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: texts.map((text, index) => ({
              object: "embedding",
              embedding: [String(text).length, index + 0.5, 3],
              index,
            })),
            model: body.model,
          }),
        );
      } catch (error) {
        requests.push({ method: req.method, url: req.url, status: 500, body: {} });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  servers.push({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return servers[servers.length - 1] as EmbeddingServer;
}

vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

describe("memory chunking upgrade fallback over a real embedding transport", () => {
  let root = "";
  let workspace = "";
  let memory = "";
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  const setStateDir = (stateDir: string): void => {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
  };

  function requireManager(
    result: Awaited<ReturnType<typeof getMemorySearchManager>>,
  ): MemoryIndexManager {
    if (!result.manager) {
      throw new Error("memory search manager missing");
    }
    return result.manager as unknown as MemoryIndexManager;
  }

  function createConfig(params: { baseUrl: string; extraPaths?: string[] }): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: "openai-compatible",
          model: "text-embedding-bge-m3",
          remote: { baseUrl: params.baseUrl, apiKey: "fixture-token" },
          outputDimensionality: 3,
          store: { vector: { enabled: true } },
          query: { minScore: 0 },
          ...(params.extraPaths ? { extraPaths: params.extraPaths } : {}),
        },
      },
      agents: { defaults: { workspace }, list: [{ id: "main", default: true }] },
    } as OpenClawConfig);
  }

  // Seeds a published index, then reopens its metadata as an older runtime's
  // index so the next search sees a pending OpenClaw chunking upgrade.
  async function seedPriorChunkingVersionIndex(cfg: OpenClawConfig): Promise<string> {
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    await manager.sync({ reason: "test", force: true });
    const dbPath = manager.status().dbPath;
    if (!dbPath) {
      throw new Error("memory search manager database path missing");
    }
    await manager.close();
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get();
      if (typeof row?.value !== "string") {
        throw new Error("fixture index metadata is missing");
      }
      const meta = JSON.parse(row.value) as Record<string, unknown>;
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify({ ...meta, chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }),
      );
    } finally {
      db.close();
    }
    return dbPath;
  }

  function createMemorySearchToolFor(cfg: OpenClawConfig) {
    const tool = createMemorySearchTool({ config: cfg, agentId: "main", oneShotCliRun: true });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    return tool;
  }

  beforeAll(async () => {
    const rawRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-mem-real-transport-"),
    );
    root = await fs.realpath(rawRoot);
    workspace = path.join(root, "workspace");
    memory = path.join(workspace, "memory");
  });

  afterAll(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    testing.resetMemorySearchToolCooldowns();
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(memory, { recursive: true });
    setStateDir(path.join(workspace, ".state-memory-index"));
    await configureMemoryCoreDreamingStateForTests();
    await fs.writeFile(
      path.join(memory, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterEach(async () => {
    const pendingServers = servers.splice(0);
    await Promise.all(pendingServers.map((server) => server.close()));
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetMemoryCoreDreamingStateForTests();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  });

  it("serves keyword results through memory_search when a real server rejects the upgrade rebuild", async () => {
    const server = await startEmbeddingServer();
    const cfg = createConfig({ baseUrl: server.baseUrl });
    const filePath = path.join(memory, "upgrade-fallback.md");
    await fs.writeFile(filePath, "UpgradeKeywordFallback()\nfinish()");
    await seedPriorChunkingVersionIndex(cfg);
    // The changed file forces the upgrade rebuild to request a fresh embedding
    // instead of republishing from the embedding cache.
    await fs.writeFile(
      filePath,
      "UpgradeKeywordFallback() changed after the prior index was published.",
    );
    server.setMode("unauthorized");

    const tool = createMemorySearchToolFor(cfg);
    try {
      const result = await tool.execute("upgrade-keyword-fallback", {
        query: "UpgradeKeywordFallback",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ path: "memory/upgrade-fallback.md" })],
      });
      expect(result.details).not.toHaveProperty("unavailable");
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
    // The rejection must have reached the real server for the rebuild's fresh
    // embedding; the seed phase answered 200 beforehand.
    expect(server.requests.some((request) => request.status === 401)).toBe(true);
    expect(server.requests.some((request) => request.status === 200)).toBe(true);
  });

  it("keeps memory_search paused when a real outage rebuild has no usable FTS index", async () => {
    const server = await startEmbeddingServer();
    const cfg = createConfig({ baseUrl: server.baseUrl });
    const filePath = path.join(memory, "upgrade-fts-paused.md");
    await fs.writeFile(filePath, "UpgradeFtsPaused()\nfinish()");
    const dbPath = await seedPriorChunkingVersionIndex(cfg);
    await fs.writeFile(filePath, "UpgradeFtsPaused() changed after the prior index was published.");
    // Occupy the FTS table name with a view so every schema ensure — including
    // the upgrade rebuild's republish — fails to restore a usable keyword index.
    const sabotaged = new DatabaseSync(dbPath);
    try {
      sabotaged.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
      sabotaged.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
    } finally {
      sabotaged.close();
    }
    server.setMode("unauthorized");

    const tool = createMemorySearchToolFor(cfg);
    try {
      const result = await tool.execute("upgrade-fts-paused", {
        query: "UpgradeFtsPaused",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        unavailable: true,
        error: expect.stringContaining("chunking"),
      });
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
    expect(server.requests.some((request) => request.status === 401)).toBe(true);
  });

  it("pauses memory_search when a real outage rebuild coincides with a changed scope", async () => {
    const server = await startEmbeddingServer();
    const wikiPath = path.join(root, "wiki");
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
    const cfgWithWiki = createConfig({ baseUrl: server.baseUrl, extraPaths: [wikiPath] });
    const cfgWithoutWiki = createConfig({ baseUrl: server.baseUrl });
    const filePath = path.join(memory, "upgrade-scope.md");
    await fs.writeFile(filePath, "UpgradeScopeMemory alpha note.");
    await seedPriorChunkingVersionIndex(cfgWithWiki);
    await fs.writeFile(filePath, "UpgradeScopeMemory note changed after the prior index.");
    server.setMode("unauthorized");

    const tool = createMemorySearchToolFor(cfgWithoutWiki);
    try {
      const result = await tool.execute("upgrade-changed-scope", {
        query: "UpgradeScopeMemory",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        unavailable: true,
        error: expect.stringContaining("chunking"),
      });
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
    expect(server.requests.some((request) => request.status === 401)).toBe(true);
  });

  it("keeps keyword results readable when a real quota-exhausted server rate-limits the rebuild", async () => {
    const server = await startEmbeddingServer();
    const cfg = createConfig({ baseUrl: server.baseUrl });
    const filePath = path.join(memory, "upgrade-quota.md");
    await fs.writeFile(filePath, "UpgradeQuotaFallback()\nfinish()");
    await seedPriorChunkingVersionIndex(cfg);
    await fs.writeFile(
      filePath,
      "UpgradeQuotaFallback() changed after the prior index was published.",
    );
    server.setMode("quota");

    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    try {
      // The search outwaits the real index retry budget: the OpenAI-style
      // quota response is rate-limited retried before the rebuild gives up.
      const results = await manager.search("UpgradeQuotaFallback");
      expect(results).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/upgrade-quota.md" })]),
      );
      expect(manager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
        code: "chunking_version",
        owner: "openclaw",
        chunkingVersionOnly: true,
      });
    } finally {
      await manager.close();
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
    // Every index retry attempt reached the real server before the fallback;
    // both the identity-repair rebuild and the follow-up background search sync
    // exhaust the full five-attempt rate-limit budget over the wire.
    expect(
      server.requests.filter((request) => request.status === 429).length,
    ).toBeGreaterThanOrEqual(5);
  });
});
