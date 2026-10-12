import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { forgetMemoryEntries } from "../memory-forget.js";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it.each([
    { mode: "targeted per-file", provider: "batch-test", force: false },
    { mode: "full per-file", provider: "batch-test", force: true },
    { mode: "full source-wide", provider: "batch-wide-test", force: true },
  ])(
    "does not publish forgotten data after pending $mode embeddings",
    async ({ provider, force }) => {
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
        messages: [
          { role: "user", timestamp: Date.now(), content: "Private violet alpha fragment." },
        ],
      });
      const embeddingEntered = createDeferred<void>();
      fixture.provider.providerRuntimeBatchEntered = () => embeddingEntered.resolve();
      let releaseEmbedding = () => {};
      fixture.provider.providerRuntimeBatchGate = new Promise<void>((resolve) => {
        releaseEmbedding = resolve;
      });
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
        publicationSql = observeHostDataSql();
        const cpuStart = process.threadCpuUsage();
        const started = performance.now();
        releaseEmbedding();
        await expect(activeSync).rejects.toThrow("forgotten while memory indexing");
        const tombstoneSql = publicationSql.queries.filter((sql) =>
          /\bfrom\s+["`]?memory_session_tombstones\b/i.test(sql),
        );
        if (process.env.OPENCLAW_MEMORY_RETRIEVAL_BENCH === "1") {
          const cpu = process.threadCpuUsage(cpuStart);
          console.log(
            "MEMORY_PUBLICATION_BENCH",
            JSON.stringify({
              operation: `forgotten-${provider}-${force ? "full" : "targeted"}`,
              cohortSqlObservations: tombstoneSql.length,
              wholeMainSqlCalls: publicationSql.calls
                .slice(1)
                .reduce((total, call) => total + call.mock.calls.length, 0),
              wholeMainCpuMs: (cpu.user + cpu.system) / 1000,
              endToEndMs: performance.now() - started,
            }),
          );
        }
        expect(tombstoneSql).toEqual([]);
        publicationSql.restore();
        publicationSql = undefined;
        expect(
          readPublishedSessionIndex(database, `sessions/main/${sessionId}.jsonl`, "violet"),
        ).toEqual({ source: undefined, chunks: [], search: [] });
        expect(database.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
        expect(manager.status().dirty).toBe(true);

        await manager.sync({ reason: "retry-after-forget", force: true });
        expect(
          readPublishedSessionIndex(database, `sessions/main/${sessionId}.jsonl`, "violet"),
        ).toEqual({ source: undefined, chunks: [], search: [] });
        expect(manager.status().dirty).toBe(false);
      } finally {
        releaseEmbedding();
        await activeSync.catch(() => undefined);
        publicationSql?.restore();
        fixture.provider.providerRuntimeBatchGate = null;
        fixture.provider.providerRuntimeBatchEntered = null;
      }
    },
  );
});
