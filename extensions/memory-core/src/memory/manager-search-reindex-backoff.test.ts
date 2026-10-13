import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search reindex backoff", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each(["openai", "auto"])(
    "keeps failed rebuilds on one retry schedule (%s)",
    async (provider) => {
      const manager = await fixture.getPersistentManager(
        fixture.createConfig({
          provider,
          sources: ["memory"],
          minScore: 0,
          cacheEnabled: false,
        }),
      );
      await manager.sync({ reason: "baseline", force: true });
      const fields = manager as unknown as { db: DatabaseSync; awaitManagerIdle(): Promise<void> };
      fields.db.exec(
        "UPDATE memory_index_meta SET value = json_set(value, '$.chunkingVersion', 0) WHERE key = 'memory_index_meta_v1'",
      );
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const embedding = vi.fn(async () => {});
      fixture.provider.beforeEmbedBatch = embedding;
      fixture.provider.embedBatchPermanentFailure = new Error("full rebuild failed");
      await expect(manager.sync({ force: true })).rejects.toThrow("full rebuild failed");
      expect(embedding).toHaveBeenCalledTimes(1);
      const searchPublished = async () => {
        const results = await manager.search("zebra", { minScore: 0 });
        expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
        await fields.awaitManagerIdle();
      };

      // Searches cannot move the deadline. Each elapsed retry doubles the delay, capped at 30m.
      for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]) {
        const attempts = embedding.mock.calls.length;
        await searchPublished();
        expect(embedding).toHaveBeenCalledTimes(attempts);
        expect(manager.status().lastSyncError).toContain(
          provider === "auto" ? "Memory sync aborted" : "full rebuild failed",
        );
        now += delay - 1;
        await searchPublished();
        expect(embedding).toHaveBeenCalledTimes(attempts);
        now += 1;
        await searchPublished();
        expect(embedding).toHaveBeenCalledTimes(attempts + 1);
      }

      fixture.provider.embedBatchPermanentFailure = null;
      now += 1_800_000;
      await searchPublished();
      expect(manager.status().lastSyncError).toBeUndefined();
      fixture.provider.embedBatchPermanentFailure = new Error("next rebuild failed");
      await expect(manager.sync({ force: true })).rejects.toThrow("next rebuild failed");
      const attempts = embedding.mock.calls.length;
      now += 30_000;
      await searchPublished();
      expect(embedding).toHaveBeenCalledTimes(attempts + 1);
    },
  );

  it.each(["missing", "older chunking"])(
    "cools down %s identity repair while preserving explicit CLI repair",
    async (identity) => {
      const manager = await fixture.getPersistentManager(
        fixture.createConfig({
          provider: "openai",
          sources: ["memory"],
          minScore: 0,
          cacheEnabled: false,
        }),
      );
      await manager.sync({ reason: "baseline", force: true });
      const fields = manager as unknown as { db: DatabaseSync };
      fields.db.exec(
        identity === "missing"
          ? "DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'"
          : "UPDATE memory_index_meta SET value = json_set(value, '$.chunkingVersion', 0) WHERE key = 'memory_index_meta_v1'",
      );
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const embedding = vi.fn(async () => {});
      fixture.provider.beforeEmbedBatch = embedding;
      fixture.provider.embedBatchPermanentFailure = new Error("identity rebuild failed");
      await manager.search("zebra");
      expect(embedding).toHaveBeenCalledTimes(1);
      await manager.search("zebra");
      expect(embedding).toHaveBeenCalledTimes(1);
      expect(manager.status().lastSyncError).toContain("identity rebuild failed");

      now += 29_000;
      await expect(manager.sync({ reason: "cli" })).rejects.toThrow("identity rebuild failed");
      expect(embedding).toHaveBeenCalledTimes(2);
      now += 1_000;
      await manager.search("zebra");
      expect(embedding).toHaveBeenCalledTimes(2);

      fixture.provider.embedBatchPermanentFailure = null;
      await manager.sync({ reason: "cli" });
      expect(embedding).toHaveBeenCalledTimes(3);
      expect(manager.status().lastSyncError).toBeUndefined();
      expect(await manager.search("zebra")).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
    },
  );

  it.each([false, true])(
    "publishes a queued session without consuming its full-rebuild retry (force=%s)",
    async (force) => {
      const sessionId = "queued-cooldown";
      const sessionKey = `agent:main:chat:${sessionId}`;
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "openai",
          sources: ["sessions"],
          sessionMemory: true,
          cacheEnabled: false,
        }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: 1, content: "Amethyst queue marker." }],
      });
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      fixture.provider.beforeEmbedBatch = async () => {
        fixture.provider.beforeEmbedBatch = null;
        started.resolve();
        await release.promise;
        throw new Error("queued rebuild failed");
      };
      const rebuild = manager.sync({ force: true });
      const failed = expect(rebuild).rejects.toThrow("queued rebuild failed");
      await started.promise;
      const queued = manager.sync({
        reason: "queued-sessions",
        force,
        sessions: [{ agentId: "main", sessionId, sessionKey }],
      });
      release.resolve();
      await failed;
      await queued;
      const fields = manager as unknown as { db: DatabaseSync };
      expect(
        readPublishedSessionIndex(fields.db, `sessions/main/${sessionId}.jsonl`, "amethyst").chunks,
      ).toHaveLength(1);
      expect(manager.status().lastSyncError).toContain("queued rebuild failed");
      const embedding = vi.fn(async () => {});
      fixture.provider.beforeEmbedBatch = embedding;
      await manager.sync({ reason: "search" });
      expect(embedding).not.toHaveBeenCalled();
      now += 30_000;
      await manager.sync({ reason: "search" });
      expect(embedding).toHaveBeenCalledTimes(1);
      expect(manager.status().lastSyncError).toBeUndefined();
    },
  );
});
