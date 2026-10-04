import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type OrphanHarness = {
  db: DatabaseSync;
  memoryFullRetryDirty: boolean;
  database: { collectOrphanedEmbeddingCache: () => Promise<boolean> };
  publishedDatabase: { db: DatabaseSync };
  writeMeta: (meta: MemoryIndexMeta) => void;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory manager orphaned embedding cache collection", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let manager: MemoryIndexManager | null = null;
  let embeddingCalls: unknown[][] = [];
  let onEmbedBatch: ((inputs: Array<string | EmbeddingInput>) => void) | undefined;

  beforeEach(async () => {
    embeddingCalls = [];
    onEmbedBatch = undefined;
    registerEmbeddingProvider({
      id: "openai",
      transport: "remote",
      create: async () => ({
        provider: {
          id: "openai",
          model: "mock-embed",
          maxInputTokens: 8192,
          embed: async () => [0, 1, 0],
          embedBatch: async (inputs) => {
            embeddingCalls.push(inputs);
            onEmbedBatch?.(inputs);
            return inputs.map(() => [0, 1, 0]);
          },
        },
      }),
    });
    fixtureRoot = tempDirs.make("openclaw-mem-orphan-cache-");
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (manager) {
      await manager.close();
      manager = null;
    }
    const { closeAllMemorySearchManagers } = await import("./index.js");
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  function createCfg(): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: {} },
          cache: { enabled: true },
          sources: ["memory"],
        },
      },
      agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    });
  }

  async function openManager(): Promise<MemoryIndexManager> {
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg: createCfg(), agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("collects cache rows no chunk references after a successful rebuild", async () => {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as OrphanHarness;
    const live = harness.db
      .prepare("SELECT provider, model, provider_key, hash FROM memory_embedding_cache")
      .all() as Array<{ provider: string; model: string; provider_key: string; hash: string }>;
    expect(live).toHaveLength(1);
    const insert = harness.db.prepare(`
      INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, 3, 1)
    `);
    // 300 orphans spans more than one collection batch.
    for (let i = 0; i < 300; i += 1) {
      insert.run(
        live[0]!.provider,
        live[0]!.model,
        live[0]!.provider_key,
        `orphan-${i}`,
        encodeMemoryEmbedding([0, 1, 0]),
      );
    }
    insert.run(
      "other-provider",
      "other-model",
      "other-key",
      "orphan-other",
      encodeMemoryEmbedding([0, 1, 0]),
    );
    const before = harness.db
      .prepare("SELECT * FROM memory_embedding_cache WHERE hash NOT LIKE 'orphan-%' ORDER BY hash")
      .all();
    const other = harness.db
      .prepare("SELECT * FROM memory_embedding_cache WHERE hash = 'orphan-other'")
      .all();

    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    // The live row is reused, not re-embedded, while orphans are collected.
    expect(embeddingCalls).toEqual([]);
    expect(
      harness.db
        .prepare(
          "SELECT * FROM memory_embedding_cache WHERE hash NOT LIKE 'orphan-%' ORDER BY hash",
        )
        .all(),
    ).toEqual(before);
    expect(
      harness.db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE hash LIKE 'orphan-%' AND provider = ?",
        )
        .get(live[0]!.provider),
    ).toEqual({ c: 0 });
    expect(
      harness.db.prepare("SELECT * FROM memory_embedding_cache WHERE hash = 'orphan-other'").all(),
    ).toEqual(other);
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "published alpha" },
    ]);
  });

  it("keeps unreferenced cache rows when a full rebuild fails", async () => {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as OrphanHarness;
    const identity = harness.db
      .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache")
      .get() as { provider: string; model: string; provider_key: string };
    harness.db
      .prepare(
        `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES (?, ?, ?, 'orphan-retry', ?, 3, 1)`,
      )
      .run(
        identity.provider,
        identity.model,
        identity.provider_key,
        encodeMemoryEmbedding([0, 1, 0]),
      );
    harness.writeMeta = () => {
      throw new Error("failed shadow metadata");
    };

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "failed shadow metadata",
    );

    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE hash = 'orphan-retry'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("publishes the rebuild even when collection fails afterward", async () => {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as OrphanHarness;
    vi.spyOn(harness.database, "collectOrphanedEmbeddingCache").mockRejectedValueOnce(
      new Error("database is locked"),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha, edited");

    await expect(memoryManager.sync({ reason: "cli", force: true })).resolves.toBeUndefined();

    expect(harness.memoryFullRetryDirty).toBe(false);

    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "published alpha, edited" },
    ]);
  });

  it("keeps a vector another sync cached during the rebuild, then collects it on a later rebuild", async () => {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as OrphanHarness;
    const identity = harness.db
      .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache")
      .get() as { provider: string; model: string; provider_key: string };
    const insert = (hash: string, updatedAt: number) =>
      harness.publishedDatabase.db
        .prepare(
          `INSERT INTO memory_embedding_cache
            (provider, model, provider_key, hash, embedding, dims, updated_at)
          VALUES (?, ?, ?, ?, ?, 3, ?)`,
        )
        .run(
          identity.provider,
          identity.model,
          identity.provider_key,
          hash,
          encodeMemoryEmbedding([0, 1, 0]),
          updatedAt,
        );
    insert("orphan-old", 1);
    // The rebuild fence and the sibling's write share one controlled clock.
    let now = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // A sibling process caches a vector for a chunk it has not published yet,
    // after this rebuild started and before it publishes.
    onEmbedBatch = () => {
      onEmbedBatch = undefined;
      insert("pending-sibling", Date.now());
    };
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha, edited");

    await memoryManager.sync({ reason: "cli", force: true });

    const hashes = () =>
      (
        harness.db
          .prepare(
            "SELECT hash FROM memory_embedding_cache WHERE hash IN ('orphan-old', 'pending-sibling') ORDER BY hash",
          )
          .all() as Array<{ hash: string }>
      ).map((row) => row.hash);
    expect(hashes()).toEqual(["pending-sibling"]);

    // Nothing publishes it, so the next rebuild treats it as dead.
    now += 1000;
    await memoryManager.sync({ reason: "cli", force: true });
    expect(hashes()).toEqual([]);
  });

  it("keeps unreferenced rows and the published index when a source fails partway", async () => {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "published beta");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as OrphanHarness;
    const identity = harness.db
      .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache")
      .get() as { provider: string; model: string; provider_key: string };
    harness.db
      .prepare(
        `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES (?, ?, ?, 'orphan-retry', ?, 3, 1)`,
      )
      .run(
        identity.provider,
        identity.model,
        identity.provider_key,
        encodeMemoryEmbedding([0, 1, 0]),
      );
    const publishedChunks = harness.db
      .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path")
      .all();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "alpha edited");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited POISON");
    onEmbedBatch = (inputs) => {
      if (
        inputs.some((input) => (typeof input === "string" ? input : input.text).includes("POISON"))
      ) {
        throw new Error("400 invalid request");
      }
    };

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "invalid request",
    );

    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE hash = 'orphan-retry'")
        .get(),
    ).toEqual({ c: 1 });
    expect(
      harness.db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all(),
    ).toEqual(publishedChunks);

    onEmbedBatch = undefined;
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited");
    await memoryManager.sync({ reason: "cli", force: true });

    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE hash = 'orphan-retry'")
        .get(),
    ).toEqual({ c: 0 });
  });
});
