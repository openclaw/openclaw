import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
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

type EmbeddingServer = {
  baseUrl: string;
  requests: number[];
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
  const requests: number[] = [];
  let mode: ServerMode = "ok";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        if (mode !== "ok") {
          const status = mode === "quota" ? 429 : 401;
          requests.push(status);
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(errorBody(mode)));
          return;
        }
        requests.push(200);
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
        requests.push(500);
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
    await closeOpenClawAgentDatabasesAsync();
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
    await closeAllMemorySearchManagers();
    const pendingServers = servers.splice(0);
    await Promise.all(pendingServers.map((server) => server.close()));
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetMemoryCoreDreamingStateForTests();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  });

  it.each(["quota", "missing FTS", "changed scope"] as const)(
    "handles %s during a rejected upgrade over the real embedding transport",
    async (scenario) => {
      const server = await startEmbeddingServer();
      const cfg = createConfig({ baseUrl: server.baseUrl });
      let indexedConfig = cfg;
      if (scenario === "changed scope") {
        const wikiPath = path.join(root, "wiki");
        await fs.mkdir(wikiPath, { recursive: true });
        await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
        indexedConfig = createConfig({ baseUrl: server.baseUrl, extraPaths: [wikiPath] });
      }
      const filePath = path.join(memory, "upgrade.md");
      await fs.writeFile(filePath, "UpgradeFallback()\nfinish()");
      const dbPath = await seedPriorChunkingVersionIndex(indexedConfig);
      // Force a fresh embedding rather than satisfying the rebuild from cache.
      await fs.writeFile(
        filePath,
        "UpgradeFallback() changed after the prior index was published.",
      );
      if (scenario === "missing FTS") {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
          db.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
        } finally {
          db.close();
        }
      }
      server.setMode(scenario === "quota" ? "quota" : "unauthorized");
      const manager =
        scenario === "quota"
          ? requireManager(await getMemorySearchManager({ cfg, agentId: "main" }))
          : undefined;
      const result = await createMemorySearchToolFor(cfg).execute("upgrade-fallback", {
        query: "UpgradeFallback",
        corpus: "memory",
      });
      if (scenario === "quota") {
        expect(result.details).toMatchObject({
          results: [expect.objectContaining({ path: "memory/upgrade.md" })],
        });
        expect(result.details).not.toHaveProperty("unavailable");
        expect(manager?.status().custom?.indexIdentity).toMatchObject({
          status: "mismatched",
          code: "chunking_version",
          owner: "openclaw",
          chunkingVersionOnly: true,
        });
      } else {
        expect(result.details).toMatchObject({
          results: [],
          disabled: true,
          unavailable: true,
          error: expect.stringContaining("HTTP 401"),
          warning: expect.stringContaining("Rebuilding may call the configured embedding provider"),
        });
      }
      expect(server.requests).toContain(200);
      // Retry counts vary with the real backoff budget; require the rejection on the wire.
      expect(server.requests).toContain(scenario === "quota" ? 429 : 401);
    },
  );
});
