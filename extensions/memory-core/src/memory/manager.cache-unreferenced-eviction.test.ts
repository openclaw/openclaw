import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type EvictionHarness = {
  db: DatabaseSync;
  cache: { maxEntries?: number };
  dirty: boolean;
  writeMeta: (meta: MemoryIndexMeta) => Promise<void>;
};

type CacheIdentity = { provider: string; model: string; provider_key: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory manager embedding cache eviction at the cap", () => {
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
    fixtureRoot = tempDirs.make("openclaw-mem-cache-eviction-");
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
    await closeOpenClawAgentDatabasesAsync();
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
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: createCfg(),
      agentId: "main",
    });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  /** The manager's own handle is read-only; tests write through the agent database. */
  function writer() {
    return openOpenClawAgentDatabase({ agentId: "main" }).db;
  }

  function insertCacheRow(identity: CacheIdentity, hash: string, updatedAt: number): void {
    writer()
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
  }

  function cacheHashes(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all() as Array<{
        hash: string;
      }>
    ).map((row) => row.hash);
  }

  /** Index two files, then age their cache rows so plain oldest-first eviction would pick them. */
  async function indexLiveRows(): Promise<{
    memoryManager: MemoryIndexManager;
    harness: EvictionHarness;
    identity: CacheIdentity;
    live: string[];
  }> {
    const memoryManager = await openManager();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "published beta");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as EvictionHarness;
    writer().prepare("UPDATE memory_embedding_cache SET updated_at = 1").run();
    const identity = harness.db
      .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache")
      .get() as CacheIdentity;
    return { memoryManager, harness, identity, live: cacheHashes(harness.db) };
  }

  it("evicts unreferenced rows before older live rows when a full rebuild exceeds the cap", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    expect(live).toHaveLength(2);
    for (let i = 0; i < 3; i += 1) {
      insertCacheRow(identity, `orphan-${i}`, 2 + i);
    }
    const foreign = { provider: "other", model: "other-model", provider_key: "other-key" };
    insertCacheRow(foreign, "orphan-foreign", 2);
    // Six rows against a cap of four: the prune removes exactly two.
    harness.cache.maxEntries = 4;
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    expect(embeddingCalls).toEqual([]);
    expect(cacheHashes(harness.db)).toEqual([...live, "orphan-2", "orphan-foreign"].toSorted());
  });

  it("evicts unreferenced rows first when an incremental sync writes at the cap", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    insertCacheRow(identity, "orphan-0", 2);
    harness.cache.maxEntries = 3;
    await fs.writeFile(path.join(memoryDir, "gamma.md"), "published gamma");
    // The file watcher is off in tests; mark the change it would report.
    harness.dirty = true;
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli" });

    expect(embeddingCalls).toHaveLength(1);
    const remaining = cacheHashes(harness.db);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain("orphan-0");
    expect(remaining).toEqual(expect.arrayContaining(live));
  });

  it("keeps plain oldest-first order for a vector another sync cached during the rebuild", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    // The rebuild start and the sibling's write share one controlled clock.
    const now = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // A sibling caches a vector for a chunk it has not published yet, after this
    // rebuild started and before it publishes. No published chunk carries its hash.
    const writeMeta = harness.writeMeta.bind(harness);
    harness.writeMeta = async (meta) => {
      insertCacheRow(identity, "pending-sibling", Date.now());
      return writeMeta(meta);
    };
    harness.cache.maxEntries = 2;

    await memoryManager.sync({ reason: "cli", force: true });

    // Three rows against two: the oldest row goes, as without a preference.
    const remaining = cacheHashes(harness.db);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("pending-sibling");
    expect(remaining.filter((hash) => live.includes(hash))).toHaveLength(1);
  });

  it("keeps a failed rebuild's vector when its retry writes at the cap", async () => {
    const { memoryManager, harness, live } = await indexLiveRows();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "alpha edited");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited POISON");
    onEmbedBatch = (inputs) => {
      if (
        inputs.some((input) => (typeof input === "string" ? input : input.text).includes("POISON"))
      ) {
        throw new Error("400 invalid request");
      }
    };
    harness.cache.maxEntries = 3;
    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "invalid request",
    );
    const retryVectors = cacheHashes(harness.db).filter((hash) => !live.includes(hash));
    expect(retryVectors).toHaveLength(1);
    onEmbedBatch = undefined;
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited");
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    // Only the fixed file is embedded; the retry vector is reused and survives
    // the eviction its write needs, which takes an older row instead.
    expect(embeddingCalls).toEqual([["beta edited"]]);
    expect(cacheHashes(harness.db)).toEqual(expect.arrayContaining(retryVectors));
  });
});
