import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const memory = await import("./index.js");

describe("memory search reindex backoff", () => {
  const fixture = createManagerIndexFixture(memory);
  const oldChunking =
    "UPDATE memory_index_meta SET value = json_set(value, '$.chunkingVersion', 0) WHERE key = 'memory_index_meta_v1'";
  async function baseline(provider = "openai") {
    const manager = await fixture.getPersistentManager(
      fixture.createConfig({ provider, sources: ["memory"], minScore: 0, cacheEnabled: false }),
    );
    await manager.sync({ reason: "baseline", force: true });
    return manager;
  }
  function clock() {
    const time = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => time.now);
    return time;
  }
  function failEmbedding(message: string) {
    const embedding = vi.fn(async () => {});
    fixture.provider.beforeEmbedBatch = embedding;
    fixture.provider.embedBatchPermanentFailure = new Error(message);
    return embedding;
  }

  it.each(["openai", "auto"])("backs off failed rebuilds (%s)", async (provider) => {
    const manager = await baseline(provider);
    const fields = manager as unknown as { awaitManagerIdle(): Promise<void> };
    memoryIndexFixtureWriter(manager).exec(oldChunking);
    const time = clock();
    const embedding = failEmbedding("full rebuild failed");
    await expect(manager.sync({ force: true })).rejects.toThrow("full rebuild failed");
    expect(embedding).toHaveBeenCalledTimes(1);
    const searchPublished = async (attempts?: number) => {
      const results = await manager.search("zebra", { minScore: 0 });
      expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await fields.awaitManagerIdle();
      if (attempts !== undefined) {
        expect(embedding).toHaveBeenCalledTimes(attempts);
      }
    };

    // Searches cannot move the deadline. Each elapsed retry doubles the delay, capped at 30m.
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]) {
      const attempts = embedding.mock.calls.length;
      await searchPublished(attempts);
      expect(manager.status().lastSyncError).toContain(
        provider === "auto" ? "Memory sync aborted" : "full rebuild failed",
      );
      time.now += delay - 1;
      await searchPublished(attempts);
      time.now += 1;
      await searchPublished(attempts + 1);
    }

    fixture.provider.embedBatchPermanentFailure = null;
    time.now += 1_800_000;
    await searchPublished();
    expect(manager.status().lastSyncError).toBeUndefined();
    fixture.provider.embedBatchPermanentFailure = new Error("next rebuild failed");
    await expect(manager.sync({ force: true })).rejects.toThrow("next rebuild failed");
    const attempts = embedding.mock.calls.length;
    time.now += 30_000;
    await searchPublished(attempts + 1);
  });

  it.each(["missing", "older chunking"])(
    "cools down %s identity but permits CLI repair",
    async (identity) => {
      const manager = await baseline();
      memoryIndexFixtureWriter(manager).exec(
        identity === "missing"
          ? "DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'"
          : oldChunking,
      );
      const time = clock();
      const embedding = failEmbedding("identity rebuild failed");
      for (let attempt = 0; attempt < 2; attempt++) {
        await manager.search("zebra");
        expect(embedding).toHaveBeenCalledTimes(1);
      }
      expect(manager.status().lastSyncError).toContain("identity rebuild failed");

      time.now += 29_000;
      await expect(manager.sync({ reason: "cli" })).rejects.toThrow("identity rebuild failed");
      expect(embedding).toHaveBeenCalledTimes(2);
      time.now += 1_000;
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

  it.each([false, true])("publishes queued sessions during backoff (force=%s)", async (force) => {
    const sessionId = "queued-cooldown";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const session = { agentId: "main", sessionId, sessionKey };
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
    const seed = (timestamp: number, content: string) =>
      fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp, content }],
      });
    await seed(1, "Amethyst queue marker.");
    const time = clock();
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
      sessions: [session],
    });
    release.resolve();
    await failed;
    await queued;
    const fields = manager as unknown as { db: DatabaseSync };
    const expectPublished = (query: string) =>
      expect(
        readPublishedSessionIndex(fields.db, `sessions/main/${sessionId}.jsonl`, query).chunks,
      ).toHaveLength(1);
    expectPublished("amethyst");
    expect(manager.status().lastSyncError).toContain("queued rebuild failed");
    const embedding = vi.fn(async () => {});
    fixture.provider.beforeEmbedBatch = embedding;
    await seed(2, "Jade pending marker.");
    // Scheduled catch-up owns transcript retries; search only reads the published index.
    await manager.sync({ reason: "session-startup-catchup" });
    expect(embedding).not.toHaveBeenCalled();
    time.now += 30_000;
    await manager.sync({ reason: "session-startup-catchup" });
    expect(embedding).toHaveBeenCalledTimes(1);
    expect(manager.status().lastSyncError).toBeUndefined();
    expectPublished("jade");
  });
});
