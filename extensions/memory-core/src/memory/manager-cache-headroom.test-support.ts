import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  observePublishedReservations,
  reservePublishedWriter,
} from "./manager-publication-observer.test-support.js";
import type { ReindexHarness } from "./manager-reindex-harness.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

export function registerCacheHeadroomTests(
  getContext: () => {
    openManager: (cfg: OpenClawConfig) => Promise<MemoryIndexManager>;
    createCfg: (params: {
      sources?: Array<"memory" | "sessions">;
      cacheEnabled?: boolean;
    }) => OpenClawConfig;
    memoryDir: string;
    resetEmbeddingCalls: () => void;
    readEmbeddingCalls: () => unknown[][];
  },
): void {
  it.each([false, true])(
    "reuses later cached files and recounts terminal population (abort=%s)",
    async (abort) => {
      const { openManager, createCfg, memoryDir, resetEmbeddingCalls, readEmbeddingCalls } =
        getContext();
      const memoryManager = await openManager(
        createCfg({ sources: ["memory"], cacheEnabled: true }),
      );
      const harness = memoryManager as unknown as ReindexHarness;
      harness.cache.maxEntries = 4;
      // One file per batch makes an early miss precede later cache reads.
      vi.spyOn(harness, "getIndexConcurrency").mockReturnValue(1);
      await fs.writeFile(path.join(memoryDir, "b.md"), "Cached beta.");
      await fs.writeFile(path.join(memoryDir, "c.md"), "Cached gamma.");
      await memoryManager.sync({ reason: "cli", force: true });
      for (const name of ["d", "e"]) {
        await fs.writeFile(path.join(memoryDir, name + ".md"), "Superseded " + name);
      }
      // Cache hits for the coming rebuild are currently unreferenced and oldest.
      for (const name of ["b", "c"]) {
        await fs.unlink(path.join(memoryDir, name + ".md"));
      }
      await memoryManager.sync({ reason: "search-bootstrap" });
      for (const name of ["d", "e"]) {
        await fs.unlink(path.join(memoryDir, name + ".md"));
      }
      await fs.writeFile(path.join(memoryDir, "b.md"), "Cached beta.");
      await fs.writeFile(path.join(memoryDir, "c.md"), "Cached gamma.");
      const published = harness.db
        .prepare("SELECT text FROM memory_index_chunks ORDER BY text")
        .all();
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 4,
      });
      await fs.writeFile(path.join(memoryDir, "a.md"), "New alpha.");
      resetEmbeddingCalls();
      if (abort) {
        harness.writeMeta = async () => {
          // A peer changes population without this worker's retained write token.
          const db = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
          try {
            for (const key of ["peer-1", "peer-2", "peer-3"]) {
              db.prepare(
                "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('peer', 'peer', 'peer', ?, ?, 3, 1)",
              ).run(key, encodeMemoryEmbedding([0, 1, 0]));
            }
          } finally {
            db.close();
          }
          throw new Error("abort after cache writes");
        };
        await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
          "abort after cache writes",
        );
        expect(
          harness.db.prepare("SELECT text FROM memory_index_chunks ORDER BY text").all(),
        ).toEqual(published);
        expect(harness.memoryFullRetryDirty).toBe(true);
      } else {
        await memoryManager.sync({ reason: "cli", force: true });
        expect(
          harness.db.prepare("SELECT text FROM memory_index_chunks ORDER BY text").all(),
        ).toEqual([{ text: "Cached beta." }, { text: "Cached gamma." }, { text: "New alpha." }]);
      }
      expect(readEmbeddingCalls().flat()).toEqual(["New alpha."]);
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 4,
      });
    },
  );

  it("rejects a replaced generation at terminal cache pruning without deleting rows", async () => {
    const { openManager, createCfg, memoryDir } = getContext();
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    const harness = memoryManager as unknown as ReindexHarness;
    harness.cache.maxEntries = 1;
    await fs.writeFile(path.join(memoryDir, "b.md"), "Published beta.");
    await memoryManager.sync({ reason: "cli", force: true });
    await fs.writeFile(path.join(memoryDir, "a.md"), "New alpha.");
    harness.writeMeta = async () => {
      throw new Error("abort before publication");
    };
    const prune = Reflect.get(
      MemoryIndexDatabase.prototype,
      "pruneEmbeddingCache",
    ) as MemoryIndexDatabase["pruneEmbeddingCache"];
    using replacement = vi
      .spyOn(MemoryIndexDatabase.prototype, "pruneEmbeddingCache")
      .mockImplementation(function (this: MemoryIndexDatabase, max, assertCurrent, recount) {
        if (recount) {
          harness.syncProviderGeneration = null;
        }
        return prune.call(this, max, assertCurrent, recount);
      });
    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "abort before publication",
    );
    expect(replacement).toHaveBeenCalled();
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get()).toEqual({
      n: 2,
    });
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "Published beta." },
    ]);
  });

  it("fences a terminal prune queued behind a revoked writer", async () => {
    const { openManager, createCfg, memoryDir } = getContext();
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    const harness = memoryManager as unknown as ReindexHarness;
    const queued = createDeferred<void>();
    let reservation: Awaited<ReturnType<typeof reservePublishedWriter>> | undefined;
    observePublishedReservations(harness.db, () => {
      if (reservation) {
        queued.resolve();
      }
    });
    harness.cache.maxEntries = 1;
    await fs.writeFile(path.join(memoryDir, "b.md"), "Published beta.");
    await memoryManager.sync({ reason: "cli", force: true });
    await fs.writeFile(path.join(memoryDir, "a.md"), "New alpha.");
    harness.writeMeta = async () => {
      throw new Error("abort before publication");
    };
    const prune = Reflect.get(
      MemoryIndexDatabase.prototype,
      "pruneEmbeddingCache",
    ) as MemoryIndexDatabase["pruneEmbeddingCache"];
    using pending = vi
      .spyOn(MemoryIndexDatabase.prototype, "pruneEmbeddingCache")
      .mockImplementation(async function (this: MemoryIndexDatabase, max, assertCurrent, recount) {
        if (recount && !reservation) {
          reservation = await reservePublishedWriter(() => {
            closeOpenClawAgentDatabasesForTest();
          });
        }
        return prune.call(this, max, assertCurrent, recount);
      });
    const sync = memoryManager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    try {
      await Promise.race([queued.promise, sync]);
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 2,
      });
      reservation?.release();
      await expect(sync).rejects.toThrow("abort before publication");
      await expect(reservation?.done).rejects.toThrow(
        "Agent database execution admission is closed",
      );
      expect(pending).toHaveBeenCalled();
      await Promise.allSettled([reservation?.done]);
      await closeOpenClawAgentDatabasesAsync();
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 2,
      });
      expect(db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "Published beta." },
      ]);
    } finally {
      reservation?.release();
      await Promise.allSettled([reservation?.done, sync]);
    }
  });
}
