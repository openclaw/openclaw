// Exercise format-upgrade fallback through real HTTP, retry policy, and SQLite.
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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runInMemoryTestBackgroundContext } from "./memory/background-context.test-support.js";
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
  status: number;
  body: Record<string, unknown>;
};

const closeServers: Array<() => Promise<void>> = [];

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function errorBody(mode: Exclude<ServerMode, "ok">): Record<string, unknown> {
  const quota = mode === "quota";
  return {
    error: {
      message: quota
        ? "You exceeded your current quota, please check your plan and billing details."
        : "Invalid API key provided.",
      type: quota ? "insufficient_quota" : "invalid_request_error",
      code: quota ? "insufficient_quota" : "invalid_api_key",
    },
  };
}

async function startEmbeddingServer() {
  const requests: CapturedRequest[] = [];
  let mode: ServerMode = "ok";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        if (mode !== "ok") {
          const status = mode === "quota" ? 429 : 401;
          requests.push({ status, body });
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(errorBody(mode)));
          return;
        }
        requests.push({ status: 200, body });
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
        requests.push({ status: 500, body: {} });
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
  const fixture = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setMode: (next: ServerMode) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  closeServers.push(fixture.close);
  return fixture;
}

vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

let root = "";
let workspace = "";
let memory = "";
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

const setStateDir = (stateDir: string): void => {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
};

async function acquireManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
  const result = await getMemorySearchManager({
    runInBackgroundContext: runInMemoryTestBackgroundContext,
    cfg,
    agentId: "main",
  });
  if (!result.manager) {
    throw new Error("memory search manager missing");
  }
  return result.manager as unknown as MemoryIndexManager;
}

function createConfig(params: {
  baseUrl: string;
  extraPaths?: string[];
  model?: string;
}): OpenClawConfig {
  return isolateMemoryManagerTestConfig({
    memory: {
      search: {
        provider: "openai-compatible",
        model: params.model ?? "text-embedding-bge-m3",
        remote: { baseUrl: params.baseUrl, apiKey: "fixture-token" },
        outputDimensionality: 3,
        store: { vector: { enabled: true } },
        query: { minScore: 0 },
        ...(params.extraPaths ? { extraPaths: params.extraPaths } : {}),
      },
    },
    agents: { defaults: { workspace }, entries: { main: {} } },
  } as OpenClawConfig);
}

// Seeds a published index, then reopens its metadata as an older runtime's
// index so the next search sees a pending OpenClaw format upgrade.
async function seedPriorFormatIndex(
  cfg: OpenClawConfig,
  version: "chunkingVersion" | "embeddingInputFormatVersion" = "chunkingVersion",
): Promise<string> {
  const manager = await acquireManager(cfg);
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
      JSON.stringify({
        ...meta,
        [version]: version === "chunkingVersion" ? MEMORY_CHUNKING_VERSION - 1 : 0,
      }),
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

async function prepareUpgrade(
  cfg: OpenClawConfig,
  name: string,
  version: "chunkingVersion" | "embeddingInputFormatVersion" = "chunkingVersion",
) {
  const filePath = path.join(memory, `${name}.md`);
  await fs.writeFile(filePath, `${name}()\nfinish()`);
  const dbPath = await seedPriorFormatIndex(cfg, version);
  // Changed input forces a fresh embedding instead of reuse from the cache.
  await fs.writeFile(filePath, `${name}() changed after the prior index was published.`);
  return dbPath;
}

async function searchTool(cfg: OpenClawConfig, query: string) {
  try {
    return await createMemorySearchToolFor(cfg).execute(query, { query, corpus: "memory" });
  } finally {
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
  }
}

function expectPaused(details: unknown) {
  expect(details).toMatchObject({
    results: [],
    disabled: true,
    unavailable: true,
    error: expect.stringContaining("HTTP 401"),
    warning: expect.stringContaining("Rebuilding may call the configured embedding provider"),
  });
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
});

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
  await closeAllMemorySearchManagers();
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

it.each([
  "chunkingVersion",
  "embeddingInputFormatVersion",
  "missing-fts",
  "changed-scope",
] as const)("handles a real unauthorized upgrade rebuild with %s", async (mode) => {
  const server = await startEmbeddingServer();
  const cfg = createConfig({
    baseUrl: server.baseUrl,
    model: mode === "embeddingInputFormatVersion" ? "embeddinggemma" : undefined,
  });
  const wikiPath = path.join(root, "wiki");
  if (mode === "changed-scope") {
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
  }
  const seedCfg =
    mode === "changed-scope"
      ? createConfig({ baseUrl: server.baseUrl, extraPaths: [wikiPath] })
      : cfg;
  const version = mode === "embeddingInputFormatVersion" ? mode : "chunkingVersion";
  const dbPath = await prepareUpgrade(seedCfg, "UpgradeKeywordFallback", version);
  if (mode === "missing-fts") {
    // A view occupies the FTS name, preventing schema repair during republish.
    const sabotaged = new DatabaseSync(dbPath);
    try {
      sabotaged.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
      sabotaged.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
    } finally {
      sabotaged.close();
    }
  }
  server.setMode("unauthorized");
  const result = await searchTool(cfg, "UpgradeKeywordFallback");
  if (mode === "missing-fts" || mode === "changed-scope") {
    expectPaused(result.details);
  } else {
    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ path: "memory/UpgradeKeywordFallback.md" })],
    });
    expect(result.details).not.toHaveProperty("unavailable");
  }
  expect(server.requests.map(({ status }) => status)).toEqual(expect.arrayContaining([200, 401]));
  if (mode === "embeddingInputFormatVersion") {
    const failedInputs = server.requests
      .filter(({ status }) => status === 401)
      .flatMap(({ body }) => body.input);
    expect(failedInputs).toContainEqual(expect.stringMatching(/^title: none \| text: /));
  }
});

it("keeps keyword results readable when a real quota-exhausted server rate-limits the rebuild", async () => {
  const server = await startEmbeddingServer();
  const cfg = createConfig({ baseUrl: server.baseUrl });
  await prepareUpgrade(cfg, "UpgradeQuotaFallback");
  server.setMode("quota");
  const manager = await acquireManager(cfg);
  try {
    // A real quota rejection rate-limits the rebuild over the wire while the
    // published keyword index stays readable.
    const results = await manager.search("UpgradeQuotaFallback");
    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/UpgradeQuotaFallback.md" })]),
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
  // Backoff races search fallback; the policy unit tests own the exact retry budget.
  expect(server.requests.some((request) => request.status === 429)).toBe(true);
});
