// Memory Core tests cover manager reindex recovery plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";

type SessionDeltaState = { lastSize: number; pendingBytes: number; pendingMessages: number };

type ReindexHarness = {
  runSafeReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runUnsafeReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncMemoryFiles: () => Promise<unknown>;
  syncSessionFiles: () => Promise<unknown>;
  writeMeta: () => void;
  dirty: boolean;
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
});
