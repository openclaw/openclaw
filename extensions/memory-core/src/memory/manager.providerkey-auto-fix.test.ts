import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const MOCK_CACHE_KEY_DATA = {
  provider: "openai-compatible",
  baseUrl: "https://dashscope.example.com/v1",
  model: "text-embedding-v4",
  dimensions: 1024,
};

const MOCK_CACHE_KEY_DATA_DIFFERENT_DIMS = {
  provider: "openai-compatible",
  baseUrl: "https://dashscope.example.com/v1",
  model: "text-embedding-v4",
  dimensions: 3072,
};

const MOCK_CACHE_KEY_DATA_DIFFERENT_BASE_URL = {
  provider: "openai-compatible",
  baseUrl: "https://different-endpoint.example.com/v1",
  model: "text-embedding-v4",
  dimensions: 1024,
};

const STALE_PROVIDER_KEY = crypto
  .createHash("sha256")
  .update(JSON.stringify({ provider: "none", model: "fts-only" }))
  .digest("hex");

const DIFFERENT_DIMS_PROVIDER_KEY = crypto
  .createHash("sha256")
  .update(JSON.stringify(MOCK_CACHE_KEY_DATA_DIFFERENT_DIMS))
  .digest("hex");

const DIFFERENT_BASE_URL_PROVIDER_KEY = crypto
  .createHash("sha256")
  .update(JSON.stringify(MOCK_CACHE_KEY_DATA_DIFFERENT_BASE_URL))
  .digest("hex");

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    requestedProvider: "openai-compatible",
    provider: {
      id: "openai-compatible",
      model: "text-embedding-v4",
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
      close: async () => {},
    },
    providerRuntime: {
      cacheKeyData: MOCK_CACHE_KEY_DATA,
    },
  })),
);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
}));

describe("memory manager auto-fixes stale FTS-only providerKey from CLI index --force", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  function indexIdentityStatus(memoryManager: MemoryIndexManager): string | undefined {
    const identity = memoryManager.status().custom?.indexIdentity as
      | { status?: string }
      | undefined;
    return identity?.status;
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-providerkey-91902-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Test topic\n\nKeep this note.");
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(): Promise<MemoryIndexManager> {
    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai-compatible",
            model: "text-embedding-v4",
            store: { path: indexPath, vector: { enabled: false } },
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function overwriteProviderKeyInMeta(providerKey: string): void {
    const db = new DatabaseSync(indexPath);
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get("memory_index_meta_v1") as
      | { value: string }
      | undefined;
    if (!row?.value) {
      db.close();
      throw new Error("no meta row found");
    }
    const meta = JSON.parse(row.value);
    meta.providerKey = providerKey;
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(
      JSON.stringify(meta),
      "memory_index_meta_v1",
    );
    db.close();
  }

  it("auto-fixes stale FTS-only providerKey written by CLI before provider init", async () => {
    const firstManager = await createManager();
    await firstManager.sync({ reason: "cli", force: true });
    expect(indexIdentityStatus(firstManager)).toBe("valid");

    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    overwriteProviderKeyInMeta(STALE_PROVIDER_KEY);

    const reopenedManager = await createManager();

    const results = await reopenedManager.search("Test topic");

    expect(indexIdentityStatus(reopenedManager)).toBe("valid");
    expect(results.length).toBeGreaterThan(0);
  });

  it("does not auto-fix when provider id also differs", async () => {
    const firstManager = await createManager();
    await firstManager.sync({ reason: "cli", force: true });

    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    const db = new DatabaseSync(indexPath);
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get("memory_index_meta_v1") as
      | { value: string }
      | undefined;
    if (!row?.value) {
      db.close();
      throw new Error("no meta row found");
    }
    const meta = JSON.parse(row.value);
    meta.providerKey = STALE_PROVIDER_KEY;
    meta.provider = "different-provider";
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(
      JSON.stringify(meta),
      "memory_index_meta_v1",
    );
    db.close();

    const reopenedManager = await createManager();

    const results = await reopenedManager.search("Test topic");

    expect(indexIdentityStatus(reopenedManager)).toBe("mismatched");
    expect(results.length).toBe(0);
  });

  it("does not auto-fix when runtime dimensions differ from index", async () => {
    const firstManager = await createManager();
    await firstManager.sync({ reason: "cli", force: true });

    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    overwriteProviderKeyInMeta(DIFFERENT_DIMS_PROVIDER_KEY);

    const reopenedManager = await createManager();

    const results = await reopenedManager.search("Test topic");

    expect(indexIdentityStatus(reopenedManager)).toBe("mismatched");
    expect(results.length).toBe(0);
  });

  it("does not auto-fix when runtime baseUrl differs from index", async () => {
    const firstManager = await createManager();
    await firstManager.sync({ reason: "cli", force: true });

    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    overwriteProviderKeyInMeta(DIFFERENT_BASE_URL_PROVIDER_KEY);

    const reopenedManager = await createManager();

    const results = await reopenedManager.search("Test topic");

    expect(indexIdentityStatus(reopenedManager)).toBe("mismatched");
    expect(results.length).toBe(0);
  });
});
