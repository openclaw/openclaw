// Memory Core search tests cover the detached full-rebuild cooldown through the serving manager.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory search reindex backoff", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig: createCfg, getPersistentManager } = fixture;

  it("serves the published index while detached rebuild failure cools down and recovers", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", sources: ["memory"], minScore: 0 }),
    );
    await manager.sync({ reason: "baseline", force: true });
    await fs.writeFile(path.join(fixture.paths.memory, "retry.md"), "new retry content");
    const serving = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      fullReindexRetryBackoff: { attempts: number; retryAt: number };
      awaitManagerIdle: () => Promise<void>;
    };
    serving.dirty = true;
    serving.memoryFullRetryDirty = true;
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let rebuildCalls = 0;
    let maintenanceCalls = 0;
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      maintenanceCalls += 1;
      const maintenance = acquired as unknown as {
        runInPlaceReindex: (params: unknown) => Promise<void>;
        writeMeta: (meta: unknown) => void;
      };
      const rebuild = maintenance.runInPlaceReindex.bind(acquired);
      vi.spyOn(maintenance, "runInPlaceReindex").mockImplementation(async (reindexParams) => {
        rebuildCalls += 1;
        await rebuild(reindexParams);
      });
      if (maintenanceCalls === 1) {
        vi.spyOn(maintenance, "writeMeta").mockImplementationOnce(() => {
          throw new Error("detached rebuild failed");
        });
      }
      return acquired;
    });

    try {
      const published = await manager.search("zebra", { minScore: 0 });
      expect(published.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await serving.awaitManagerIdle();
      expect(rebuildCalls).toBe(1);
      expect(serving.fullReindexRetryBackoff).toEqual({ attempts: 1, retryAt: now + 30_000 });
      expect(manager.status().lastSyncError).toContain("detached rebuild failed");
      expect(await manager.search("new retry content", { minScore: 0 })).toEqual([]);
      await serving.awaitManagerIdle();
      expect(maintenanceCalls).toBe(2);
      expect(rebuildCalls).toBe(1);
      expect(manager.status().lastSyncError).toContain("detached rebuild failed");

      now = serving.fullReindexRetryBackoff.retryAt;
      const stillPublished = await manager.search("zebra", { minScore: 0 });
      expect(stillPublished.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await serving.awaitManagerIdle();
      expect(rebuildCalls).toBe(2);
      expect(serving.fullReindexRetryBackoff).toEqual({ attempts: 0, retryAt: 0 });
      expect(manager.status().lastSyncError).toBeUndefined();
      expect(await manager.search("new retry content", { minScore: 0 })).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/retry.md" })]),
      );
    } finally {
      getSpy.mockRestore();
      await serving.awaitManagerIdle();
    }
  });

  it.each(["missing", "older runtime"] as const)(
    "cools down a failed %s identity repair across searches",
    async (identity) => {
      const manager = await getPersistentManager(
        createCfg({ provider: "none", sources: ["memory"], minScore: 0 }),
      );
      await manager.sync({ reason: "baseline", force: true });
      const fields = manager as unknown as {
        db: DatabaseSync;
        writeMeta: (meta: unknown) => void;
        runInPlaceReindex: (params: unknown) => Promise<void>;
        fullReindexRetryBackoff: { attempts: number; retryAt: number };
      };
      if (identity === "missing") {
        fields.db
          .prepare("DELETE FROM memory_index_meta WHERE key = ?")
          .run("memory_index_meta_v1");
      } else {
        fields.db
          .prepare(
            "UPDATE memory_index_meta SET value = json_set(value, '$.chunkingVersion', 0) WHERE key = ?",
          )
          .run("memory_index_meta_v1");
      }
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const rebuild = vi.spyOn(fields, "runInPlaceReindex");
      vi.spyOn(fields, "writeMeta").mockImplementationOnce(() => {
        throw new Error("identity rebuild failed");
      });

      await manager.search("zebra", { minScore: 0 });
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(fields.fullReindexRetryBackoff).toEqual({ attempts: 1, retryAt: now + 30_000 });
      await manager.search("zebra", { minScore: 0 });
      expect(rebuild).toHaveBeenCalledTimes(1);

      now = fields.fullReindexRetryBackoff.retryAt;
      const recovered = await manager.search("zebra", { minScore: 0 });
      expect(rebuild).toHaveBeenCalledTimes(2);
      expect(recovered.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      expect(fields.fullReindexRetryBackoff).toEqual({ attempts: 0, retryAt: 0 });
    },
  );

  it("allows explicit CLI identity repair during automatic retry cooldown", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", sources: ["memory"], minScore: 0 }),
    );
    await manager.sync({ reason: "baseline", force: true });
    const fields = manager as unknown as {
      db: DatabaseSync;
      writeMeta: (meta: unknown) => void;
      runInPlaceReindex: (params: unknown) => Promise<void>;
      fullReindexRetryBackoff: { attempts: number; retryAt: number };
    };
    fields.db.prepare("DELETE FROM memory_index_meta WHERE key = ?").run("memory_index_meta_v1");
    const rebuild = vi.spyOn(fields, "runInPlaceReindex");
    vi.spyOn(fields, "writeMeta").mockImplementationOnce(() => {
      throw new Error("automatic identity rebuild failed");
    });

    await manager.search("zebra", { minScore: 0 });
    expect(fields.fullReindexRetryBackoff.attempts).toBe(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    await manager.sync({ reason: "cli" });
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(fields.fullReindexRetryBackoff).toEqual({ attempts: 0, retryAt: 0 });
  });

  it.each([false, true])(
    "indexes a queued session target while a failed full rebuild cools down (force=%s)",
    async (force) => {
      const sessionId = "queued-cooldown";
      const sessionKey = `agent:main:chat:${sessionId}`;
      const sessionPath = `sessions/main/${sessionId}.jsonl`;
      const manager = await fixture.getFreshManager(
        createCfg({ provider: "openai", sources: ["sessions"], sessionMemory: true, minScore: 0 }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: 1, content: "Amethyst queue marker." }],
      });
      const fields = manager as unknown as {
        db: DatabaseSync;
        writeMeta: (meta: unknown) => void;
        fullReindexRetryBackoff: { attempts: number; retryAt: number };
      };
      expect(readPublishedSessionIndex(fields.db, sessionPath, "amethyst").chunks).toEqual([]);
      const embeddingStarted = createDeferred<void>();
      const releaseEmbedding = createDeferred<void>();
      fixture.provider.beforeEmbedBatch = async () => {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      };
      vi.spyOn(fields, "writeMeta").mockImplementationOnce(() => {
        throw new Error("queued rebuild failed");
      });

      const failedRebuild = manager.sync({ reason: "search", force: true });
      const failedRebuildAssertion = expect(failedRebuild).rejects.toThrow("queued rebuild failed");
      await embeddingStarted.promise;
      const queued = manager.sync({
        reason: "queued-sessions",
        force,
        sessions: [{ agentId: "main", sessionId, sessionKey }],
      });
      releaseEmbedding.resolve();
      await failedRebuildAssertion;
      await queued;

      expect(fields.fullReindexRetryBackoff.attempts).toBe(1);
      expect(readPublishedSessionIndex(fields.db, sessionPath, "amethyst").chunks).toHaveLength(1);
      expect(manager.status().lastSyncError).toContain("queued rebuild failed");
    },
  );
});
