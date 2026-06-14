// Memory Core tests cover manager reindex recovery plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

type SessionDeltaState = { lastSize: number; pendingBytes: number; pendingMessages: number };
type SyncSessionParams = { needsFullReindex: boolean; targetSessionFiles?: string[] };

type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runSafeReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runUnsafeReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
  syncSessionFiles: (params: SyncSessionParams) => Promise<unknown>;
  upsertEmbeddingCacheEntries: (
    entries: Array<{ hash: string; embedding: number[] }>,
    provider?: { id: string; model: string } | null,
  ) => void;
  db: DatabaseSync;
  writeMeta: (meta: MemoryIndexMeta) => void;
  embeddingCacheMirrorDb: DatabaseSync | null;
  providerKey: string | null;
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
  sessionDeltas: Map<string, SessionDeltaState>;
};

describe("memory manager reindex recovery", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-reindex-recovery-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
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
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createCfg(params: {
    storePath: string;
    provider?: string;
    sources?: Array<"memory" | "sessions">;
    cacheEnabled?: boolean;
    chunkTokens?: number;
  }): OpenClawConfig {
    return {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "openai",
            model: "mock-embed",
            store: { path: params.storePath, vector: { enabled: false } },
            chunking: { tokens: params.chunkTokens ?? 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            remote: { nonBatchConcurrency: 1 },
            cache: { enabled: params.cacheEnabled ?? false },
            sources: params.sources,
            experimental: { sessionMemory: params.sources?.includes("sessions") ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  async function openManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
      throw new Error("manager does not support sync");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function readCacheRowCount(dbPath: string): number {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM embedding_cache").get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  function deleteEmbeddingCacheRows(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DELETE FROM embedding_cache");
    } finally {
      db.close();
    }
  }

  it.each(["runSafeReindex", "runUnsafeReindex"] as const)(
    "restores retry state after %s fails late in a full reindex",
    async (method) => {
      const storePath = path.join(workspaceDir, `index-${method}.sqlite`);
      const memoryManager = await openManager(
        createCfg({
          storePath,
          provider: "none",
          sources: ["memory", "sessions"],
        }),
      );
      const harness = memoryManager as unknown as ReindexHarness;
      const dirtySessionFile = path.join(workspaceDir, "sessions", "dirty.jsonl");
      const originalDelta: SessionDeltaState = {
        lastSize: 42,
        pendingBytes: 100,
        pendingMessages: 2,
      };
      const emptySyncPlan = { indexItems: [], finalize: () => undefined };

      harness.dirty = true;
      harness.sessionsDirty = true;
      harness.sessionsDirtyFiles.add(dirtySessionFile);
      harness.sessionDeltas.set(dirtySessionFile, { ...originalDelta });
      harness.syncMemoryFiles = async () => emptySyncPlan;
      harness.syncSessionFiles = async () => {
        const delta = harness.sessionDeltas.get(dirtySessionFile);
        if (delta) {
          delta.lastSize = 500;
          delta.pendingBytes = 0;
          delta.pendingMessages = 0;
        }
        return emptySyncPlan;
      };
      harness.writeMeta = () => {
        throw new Error("late reindex failure");
      };

      await expect(harness[method]({ reason: "test", force: true })).rejects.toThrow(
        "late reindex failure",
      );

      expect(harness.dirty).toBe(true);
      expect(harness.memoryFullRetryDirty).toBe(true);
      expect(harness.sessionsDirty).toBe(true);
      expect(Array.from(harness.sessionsDirtyFiles)).toEqual([dirtySessionFile]);
      expect(harness.sessionDeltas.get(dirtySessionFile)).toEqual(originalDelta);
    },
  );

  it.each(["runSafeReindex", "runUnsafeReindex"] as const)(
    "marks clean full reindex work dirty after %s fails late",
    async (method) => {
      const storePath = path.join(workspaceDir, `index-clean-retry-${method}.sqlite`);
      const memoryManager = await openManager(
        createCfg({
          storePath,
          provider: "none",
          sources: ["memory", "sessions"],
        }),
      );
      const harness = memoryManager as unknown as ReindexHarness;
      const emptySyncPlan = { indexItems: [], finalize: () => undefined };

      harness.syncMemoryFiles = async () => emptySyncPlan;
      harness.syncSessionFiles = async () => emptySyncPlan;
      harness.writeMeta = () => {
        throw new Error("late clean reindex failure");
      };

      await expect(harness[method]({ reason: "test", force: true })).rejects.toThrow(
        "late clean reindex failure",
      );

      expect(harness.dirty).toBe(true);
      expect(harness.sessionsDirty).toBe(true);
      expect(harness.sessionsFullRetryDirty).toBe(true);
      expect(harness.sessionsDirtyFiles.size).toBe(0);
    },
  );

  it("forces source-wide session sync when retrying a failed full reindex", async () => {
    const storePath = path.join(workspaceDir, "index-full-session-retry.sqlite");
    const memoryManager = await openManager(
      createCfg({
        storePath,
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };
    const sessionSyncCalls: SyncSessionParams[] = [];

    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.sessionsDirtyFiles.clear();
    harness.syncSessionFiles = async (params) => {
      sessionSyncCalls.push(params);
      return emptySyncPlan;
    };

    await harness.sync({ reason: "test" });

    expect(sessionSyncCalls).toHaveLength(1);
    expect(sessionSyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(sessionSyncCalls[0]?.targetSessionFiles).toBeUndefined();
    expect(harness.sessionsDirty).toBe(false);
    expect(harness.sessionsFullRetryDirty).toBe(false);
  });

  it("full-reindexes sessions-only retry state when metadata is mismatched", async () => {
    const storePath = path.join(workspaceDir, "index-full-session-identity-retry.sqlite");
    const memoryManager = await openManager(
      createCfg({
        storePath,
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const reindexCalls: Array<{ reason?: string; force?: boolean }> = [];

    harness.db
      .prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "sessions-retry-chunk",
        "sessions/retry.jsonl",
        "sessions",
        1,
        1,
        "sessions-retry-hash",
        "fts-only",
        "sessions retry marker",
        "[]",
        Date.now(),
      );
    harness.writeMeta({
      model: "fts-only",
      provider: "none",
      providerKey: harness.providerKey ?? undefined,
      sources: ["memory"],
      chunkTokens: 4000,
      chunkOverlap: 0,
    });
    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.runSafeReindex = async (params) => {
      reindexCalls.push(params);
    };

    await harness.sync({ reason: "test" });

    expect(reindexCalls).toHaveLength(1);
    expect(reindexCalls[0]).toMatchObject({ reason: "test" });
  });

  it("forces source-wide memory sync when retrying a failed full reindex", async () => {
    const storePath = path.join(workspaceDir, "index-full-memory-retry.sqlite");
    const memoryManager = await openManager(
      createCfg({
        storePath,
        provider: "none",
        sources: ["memory"],
      }),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "alpha", "utf8");
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };
    const memorySyncCalls: Array<{ needsFullReindex: boolean }> = [];

    harness.dirty = true;
    harness.memoryFullRetryDirty = true;
    harness.syncMemoryFiles = async (params: { needsFullReindex: boolean }) => {
      memorySyncCalls.push(params);
      return emptySyncPlan;
    };

    await harness.sync({ reason: "test" });

    expect(memorySyncCalls).toHaveLength(1);
    expect(memorySyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(harness.dirty).toBe(false);
    expect(harness.memoryFullRetryDirty).toBe(false);
  });

  it("mirrors each successful safe-reindex cache batch into the old index", async () => {
    const storePath = path.join(workspaceDir, "index-cache-mirror.sqlite");
    const memoryManager = await openManager(
      createCfg({
        storePath,
        cacheEnabled: true,
        chunkTokens: 1200,
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });
    deleteEmbeddingCacheRows(storePath);
    expect(readCacheRowCount(storePath)).toBe(0);

    await fs.writeFile(
      path.join(memoryDir, "02-large.md"),
      [
        "Cache alpha line. ".repeat(250),
        "Cache gamma line. ".repeat(250),
        "Cache delta line. ".repeat(250),
      ].join("\n"),
    );

    let calls = 0;
    const embedBatchMock = getEmbedBatchMock();
    embedBatchMock.mockImplementation(async (texts: string[]) => {
      calls += 1;
      if (calls === 1) {
        return texts.map(() => [1, 0, 0]);
      }
      throw new Error("planned reindex embed failure");
    });

    await expect(memoryManager.sync({ reason: "test", force: true })).rejects.toThrow(
      "planned reindex embed failure",
    );

    expect(embedBatchMock).toHaveBeenCalledTimes(2);
    expect(readCacheRowCount(storePath)).toBe(1);

    embedBatchMock.mockClear();
    embedBatchMock.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    await memoryManager.sync({ reason: "test", force: true });

    expect(embedBatchMock).toHaveBeenCalledTimes(2);
    expect(readCacheRowCount(storePath)).toBe(3);
  });

  it("keeps reindex cache writes non-fatal when the old-index mirror fails", async () => {
    const storePath = path.join(workspaceDir, "index-cache-mirror-best-effort.sqlite");
    const memoryManager = await openManager(
      createCfg({
        storePath,
        cacheEnabled: true,
      }),
    );
    const harness = memoryManager as unknown as ReindexHarness;
    harness.providerKey = "mirror-provider-key";
    harness.embeddingCacheMirrorDb = {
      prepare: () => {
        throw new Error("mirror database locked");
      },
    } as unknown as DatabaseSync;

    expect(() => {
      harness.upsertEmbeddingCacheEntries([{ hash: "mirror-hash", embedding: [1, 2, 3] }], {
        id: "openai",
        model: "mock-embed",
      });
    }).not.toThrow();

    expect(readCacheRowCount(storePath)).toBe(1);
  });
});
