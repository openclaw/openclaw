// Memory Core tests cover manager.fts only reindex plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  })),
);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
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

  async function createManager(
    params: { provider?: string; vectorEnabled?: boolean } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? { path: indexPath }
        : { path: indexPath, vector: { enabled: params.vectorEnabled } };
    const cfg = {
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "auto",
            model: "",
            store,
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

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  function writeExistingMeta(memoryManager: MemoryIndexManager, model: string): void {
    const metaWriter = memoryManager as unknown as {
      writeMeta(meta: MemoryIndexMeta): void;
    };
    metaWriter.writeMeta({
      model,
      provider: "openai",
      chunkTokens: 600,
      chunkOverlap: 120,
      sources: ["memory"],
    });
  }

  it("preserves indexed chunks across forced reindex in FTS-only mode", async () => {
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });
    const firstStatus = memoryManager.status();
    expect(firstStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);

    await memoryManager.sync({ force: true });
    const secondStatus = memoryManager.status();
    expect(secondStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("syncs explicit provider-none memory without resolving an embedding provider", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("reports explicit provider-none probes as FTS-only without resolving providers", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("forces provider-none memory to FTS-only when vector config is omitted", async () => {
    const memoryManager = await createManager({ provider: "none" });

    await memoryManager.sync({ force: true });

    const status = memoryManager.status();
    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(status.vector).toMatchObject({ enabled: false });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("still initializes configured providers when vector storage is disabled", async () => {
    const memoryManager = await createManager({ provider: "auto", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("refreshes FTS-only indexed content after memory file updates", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta refresh marker\n\nUpdated memory content.",
    );
    await memoryManager.sync({ force: true });

    expect(countChunksContaining("refresh marker")).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    const memoryManager = await createManager();
    writeExistingMeta(memoryManager, "mock-embed");

    await expect(memoryManager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(memoryManager.status().provider).toBe("openai");
  });

  it("triggers verified reindex when identity is missing but indexed chunks exist", async () => {
    // Explicit "none" provider: FTS-only, no semantic downgrade risk.
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });
    await memoryManager.sync({ force: true });

    // Sanity: after initial sync, meta is present and chunks exist.
    expect(memoryManager.status().chunks).toBeGreaterThan(0);
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    // Delete meta via the manager's own DB to simulate the dead-loop condition.
    const internals = memoryManager as unknown as {
      db: DatabaseSync;
      readMeta(): MemoryIndexMeta | null;
    };
    internals.db.exec("DELETE FROM meta WHERE key = 'memory_index_meta_v1'");

    // Verify meta was actually deleted.
    expect(internals.readMeta()).toBeNull();

    // Without force, the recovery path triggers a verified full reindex
    // (runSafeReindex) instead of writing unverified meta. The reindex
    // prunes stale rows and writes meta only after verification.
    await memoryManager.sync();

    // After the fix: meta is recreated via verified reindex, dead loop broken.
    const metaAfter = internals.readMeta();
    expect(metaAfter).not.toBeNull();
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("prunes stale chunks during missing-meta recovery when memory files are deleted", async () => {
    // Explicit "none" provider: FTS-only, no semantic downgrade risk.
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });
    await memoryManager.sync({ force: true });

    // Sanity: chunks exist from current MEMORY.md.
    const initialChunks = memoryManager.status().chunks;
    expect(initialChunks).toBeGreaterThan(0);

    // Delete the memory file from disk — its chunks are now stale.
    await fs.rm(path.join(workspaceDir, "MEMORY.md"));

    // Delete meta to trigger the recovery path.
    const internals = memoryManager as unknown as {
      db: DatabaseSync;
      readMeta(): MemoryIndexMeta | null;
    };
    internals.db.exec("DELETE FROM meta WHERE key = 'memory_index_meta_v1'");
    expect(internals.readMeta()).toBeNull();

    // Sync without force — recovery path triggers verified reindex.
    // The reindex scans current sources, finds no memory files,
    // and prunes stale chunks from the deleted path.
    await memoryManager.sync();

    // Stale chunks from deleted paths are pruned.
    const chunksAfter = (
      internals.db.prepare("SELECT count(*) as c FROM chunks").get() as { c: number }
    ).c;
    expect(chunksAfter).toBe(0);

    // Meta is recreated, identity valid — dead loop broken.
    expect(internals.readMeta()).not.toBeNull();
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("preserves index when specific provider is configured but unavailable during missing-meta recovery", async () => {
    // Configure a specific embedding provider that is unavailable.
    const memoryManager = await createManager({ provider: "openai" });
    await memoryManager.sync({ force: true });

    expect(memoryManager.status().chunks).toBeGreaterThan(0);

    // Delete meta to simulate the dead-loop condition.
    const internals = memoryManager as unknown as {
      db: DatabaseSync;
      readMeta(): MemoryIndexMeta | null;
    };
    internals.db.exec("DELETE FROM meta WHERE key = 'memory_index_meta_v1'");
    expect(internals.readMeta()).toBeNull();

    // Sync without force — recovery path detects that a specific provider
    // ("openai") is configured but unavailable. Existing chunks may be
    // semantic, so the index stays dirty/paused instead of forcing an
    // FTS-only reindex that would wipe vector embeddings.
    await memoryManager.sync();

    // Meta stays missing, index stays dirty — provider outage preserved.
    expect(internals.readMeta()).toBeNull();
    expect(memoryManager.status().dirty).toBe(true);
    expect(memoryManager.status().custom?.indexIdentity).toMatchObject({
      status: "missing",
    });
  });
});
