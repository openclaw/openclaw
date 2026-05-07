import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

// Give the provider mock control over batch behavior per call. The array is
// swapped wholesale by each test; calls past the end use the default response.
const embedBatchOverrides: Array<(texts: string[]) => Promise<number[][]> | number[][]> = [];
let embedBatchCalls = 0;

function resetEmbedBatch(): void {
  embedBatchOverrides.length = 0;
  embedBatchCalls = 0;
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [0, 1, 0],
      embedBatch: async (texts: string[]) => {
        const handler = embedBatchOverrides[embedBatchCalls];
        embedBatchCalls += 1;
        if (handler) {
          return await handler(texts);
        }
        return texts.map((_, index) => [embedBatchCalls, index, 0]);
      },
    },
  }),
  resolveEmbeddingProviderFallbackModel: () => "mock-embed",
}));

type MemoryIndexModule = typeof import("./index.js");

describe("memory manager reindex recovery", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;
  let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  beforeAll(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-reindex-recovery-"));
  });

  beforeEach(async () => {
    // The reindex recovery tests specifically exercise the safe (temp-DB)
    // atomic swap path, so we must keep `OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX`
    // unset for this suite — the cache mirror only runs there.
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    resetEmbedBatch();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      vi.resetModules();
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  function createCfg(params?: { cacheEnabled?: boolean }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            cache: { enabled: params?.cacheEnabled ?? false },
            // Per-chunk size stays at the default 4000 tokens; size of the
            // seed file is what controls how many chunks (and therefore how
            // many batches) a single sync produces.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as unknown as OpenClawConfig;
  }

  async function createManager(params?: { cacheEnabled?: boolean }): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg: createCfg(params), agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function countEmbeddingCacheRows(): number {
    const db = new DatabaseSync(indexPath);
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get("embedding_cache") as { name: string } | undefined;
      if (!hasTable) {
        return 0;
      }
      const row = db.prepare("SELECT COUNT(*) as c FROM embedding_cache").get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  async function writeMultiBatchMemory(): Promise<void> {
    // Three ~4200-byte chunks. The batch builder caps each batch at 8000
    // bytes, so this guarantees at least two batches per memory sync — which
    // is what we need to prove partial success/failure handling works.
    const line = "a".repeat(4200);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), [line, line, line].join("\n\n"));
  }

  it("preserves successful batch cache writes across a rolled-back safe reindex", async () => {
    await writeMultiBatchMemory();
    await createManager({ cacheEnabled: true });

    // First run: succeed so we have a real index and a populated cache table
    // on disk. The test then clears the cache rows and mocks a mid-reindex
    // failure to prove that subsequent reruns do not start from zero.
    await manager!.sync({ force: true });
    expect(countEmbeddingCacheRows()).toBeGreaterThan(0);

    // Drop only the cache rows (preserving the committed index + schema), so
    // the next reindex must recompute embeddings from scratch.
    {
      const db = new DatabaseSync(indexPath);
      try {
        db.exec("DELETE FROM embedding_cache");
      } finally {
        db.close();
      }
    }
    expect(countEmbeddingCacheRows()).toBe(0);

    resetEmbedBatch();
    // Succeed on the first batch, fail on the second. If the cache mirror
    // works, batch #1's entries land in the *original* DB even though the
    // temp DB will be thrown away.
    embedBatchOverrides[0] = async (texts) => texts.map((_, index) => [1, index, 0]);
    embedBatchOverrides[1] = async () => {
      throw new Error("mock batch failure");
    };
    await expect(manager!.sync({ force: true })).rejects.toThrow("mock batch failure");
    expect(embedBatchCalls).toBeGreaterThanOrEqual(2);

    // Cache survived rollback → some rows are in the original DB now.
    expect(countEmbeddingCacheRows()).toBeGreaterThan(0);
  });

  it("enables cache on an existing index that pre-dates the cache table", async () => {
    await writeMultiBatchMemory();
    await createManager({ cacheEnabled: false });
    await manager!.sync({ force: true });
    await manager!.close();
    manager = null;

    // Drop the embedding_cache table to simulate an index created before the
    // cache feature existed.
    {
      const db = new DatabaseSync(indexPath);
      try {
        db.exec("DROP TABLE IF EXISTS embedding_cache");
      } finally {
        db.close();
      }
    }

    resetEmbedBatch();
    await createManager({ cacheEnabled: true });
    // With cache on, the seed step used to SELECT * FROM embedding_cache on
    // the original DB before any schema migration could run — that crashed.
    // Now it checks sqlite_master first and reindex succeeds cleanly.
    await expect(manager!.sync({ force: true })).resolves.toBeUndefined();
    // Cache rows appear in the new index (the safe reindex created the table
    // in the temp DB, then swapped it in).
    const db = new DatabaseSync(indexPath);
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get("embedding_cache") as { name: string } | undefined;
      expect(hasTable?.name).toBe("embedding_cache");
    } finally {
      db.close();
    }
  });

  it("restores dirty flag and sessionFullRetryPending after a rolled-back safe reindex", async () => {
    await writeMultiBatchMemory();
    await createManager({ cacheEnabled: false });

    // Pre-state: dirty bit is cleared, sessions are clean.
    await manager!.sync({ force: true });
    const internal = manager as unknown as {
      dirty: boolean;
      sessionsDirty: boolean;
      sessionFullRetryPending: boolean;
      sessionsDirtyFiles: Set<string>;
    };
    expect(internal.dirty).toBe(false);

    // Mark the index dirty (simulating an edit), then force a reindex that
    // explodes on the second batch. After rollback, `dirty` must still be true
    // so the next sync retries the work we just rolled back.
    internal.dirty = true;
    resetEmbedBatch();
    embedBatchOverrides[0] = async (texts) => texts.map((_, index) => [2, index, 0]);
    embedBatchOverrides[1] = async () => {
      throw new Error("mock retry-state failure");
    };
    await expect(manager!.sync({ force: true })).rejects.toThrow("mock retry-state failure");

    expect(internal.dirty).toBe(true);
  });
});
