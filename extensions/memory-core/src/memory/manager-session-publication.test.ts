import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { forgetMemoryEntries } from "../memory-forget.js";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const memory = await import("./index.js");

describe("memory session publication", () => {
  const fixture = createManagerIndexFixture(memory);
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it.each([
    { mode: "targeted per-file", provider: "batch-test", force: false },
    { mode: "full per-file", provider: "batch-test", force: true },
    { mode: "full source-wide", provider: "batch-wide-test", force: true },
  ])("blocks forgotten $mode publication", async ({ provider, force }) => {
    const sessionId = "forgotten-during-embedding";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const cfg = createConfig({
      provider,
      batchEnabled: true,
      vectorEnabled: false,
      cacheEnabled: true,
      sources: ["sessions"],
      sessionMemory: true,
    });
    const manager = await getFreshManager(cfg, "cli");
    await manager.sync({ reason: "index-empty-corpus", force: true });
    await seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [{ role: "user", timestamp: 1, content: "Private violet." }],
    });
    const embeddingEntered = createDeferred<void>();
    fixture.provider.providerRuntimeBatchEntered = () => embeddingEntered.resolve();
    const embeddingReleased = createDeferred<void>();
    fixture.provider.providerRuntimeBatchGate = embeddingReleased.promise;
    const activeSync = manager.sync({
      reason: "forget-during-embedding",
      ...(force ? { force: true } : { sessions: [{ agentId: "main", sessionId, sessionKey }] }),
    });
    let publicationSql: ReturnType<typeof observeHostDataSql> | undefined;
    try {
      await Promise.race([
        embeddingEntered.promise,
        activeSync.then(() => {
          throw new Error("memory sync completed before the embedding batch entered");
        }),
      ]);
      expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1);
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
      const database = Reflect.get(manager, "db") as DatabaseSync;
      const expectUnpublished = () =>
        expect(
          readPublishedSessionIndex(database, `sessions/main/${sessionId}.jsonl`, "violet"),
        ).toEqual({ source: undefined, chunks: [], search: [] });
      publicationSql = observeHostDataSql();
      embeddingReleased.resolve();
      await expect(activeSync).rejects.toThrow("forgotten while memory indexing");
      const tombstoneSql = publicationSql.queries.filter((sql) =>
        /\bfrom\s+["`]?memory_session_tombstones\b/i.test(sql),
      );
      expect(tombstoneSql).toEqual([]);
      publicationSql.restore();
      publicationSql = undefined;
      expectUnpublished();
      expect(database.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
      expect(manager.status().dirty).toBe(true);

      await manager.sync({ reason: "retry-after-forget", force: true });
      expectUnpublished();
      expect(manager.status().dirty).toBe(false);
    } finally {
      embeddingReleased.resolve();
      await activeSync.catch(() => undefined);
      publicationSql?.restore();
    }
  });
});
