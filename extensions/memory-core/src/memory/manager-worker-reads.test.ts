import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readTranscriptStatsBatchReadOnlySync } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import * as cpuRuntime from "./manager-cpu-worker-runtime.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";
import { observePublishedSql } from "./manager-publication-observer.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager retained worker reads", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("reopens invalidated source state without host data reads", async () => {
    await fs.writeFile(path.join(fixture.paths.memory, "cold.md"), "Alpha cold source.");
    const config = fixture.createConfig({ provider: "none", sources: ["memory"] });
    const initial = await fixture.getFreshManager(config, "cli");
    await initial.sync({ reason: "baseline", force: true });
    memoryIndexFixtureWriter(initial).prepare("UPDATE memory_index_sources SET hash = ''").run();
    await initial.close();
    const observed = observeHostDataSql();
    try {
      const manager = await fixture.getFreshManager(config, "cli");
      expect(Reflect.get(manager, "memorySourceProvenanceRepairPending")).toBe(true);
      expect(observed.queries.filter((sql) => /memory_index_sources/iu.test(sql))).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("loads vectors and publishes a full reindex without host SQLite", async () => {
    await fs.writeFile(path.join(fixture.paths.memory, "vectors.md"), "Alpha vector source.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "openai",
        sources: ["memory"],
        vectorEnabled: true,
      }),
      "cli",
    );
    const observed = observeHostDataSql();
    try {
      await manager.sync({ reason: "cold-vectors", force: true });
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
    expect((await manager.search("alpha", { minScore: 0 })).length).toBeGreaterThan(0);
    expect(Reflect.get(manager, "publishedDatabase").facts.hasVectorTable).toBe(true);
  });

  it("keeps transcript statistics off the host during session catch-up", async () => {
    await fixture.seedSessionTranscript({
      sessionId: "startup-stats",
      messages: [{ role: "user", timestamp: 1, content: "Published startup statistics." }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    const observed = observeHostDataSql();
    try {
      await manager.sync({ reason: "cli" });
      expect(
        observed.queries.filter(
          (sql) => /transcript_events/i.test(sql) && /\b(?:count|sum)\s*\(/i.test(sql),
        ),
      ).toEqual([]);
      expect(
        observed.queries.filter(
          (sql) => /^select\b/i.test(sql) && /memory_index_sources/i.test(sql),
        ),
      ).toEqual([]);
      expect(manager.status().dirty).toBe(false);
    } finally {
      observed.restore();
    }
  });

  it("preserves grouped statistics, duplicate ordering, and missing stores across the worker", async () => {
    await fixture.seedSessionTranscript({
      sessionId: "stats-parity",
      messages: [{ role: "user", timestamp: 1, content: "Worker statistics parity." }],
    });
    const source = { agentId: "main", sessionId: "stats-parity" };
    const scopes = [
      source,
      ...Array.from({ length: 401 }, (_, index) => ({
        agentId: "main",
        sessionId: `absent-${index}`,
      })),
      source,
      { agentId: "missing", sessionId: "missing" },
    ];
    const expected = readTranscriptStatsBatchReadOnlySync(scopes);
    const observed = observeHostDataSql();
    try {
      const actual = await cpuRuntime.readMemoryTranscriptStatsInWorker(scopes);
      expect(actual).toEqual(expected);
      expect(actual[0]?.eventCount).toBeGreaterThan(0);
      expect(actual.at(-2)).toEqual(actual[0]);
      expect(actual.at(-1)).toBeNull();
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("joins a startup statistics read before closing without scheduling late sync", async () => {
    await fixture.seedSessionTranscript({
      sessionId: "startup-close",
      messages: [{ role: "user", timestamp: 1, content: "Unindexed startup statistics." }],
    });
    const delivered = createDeferred<void>();
    const release = createDeferred<void>();
    const read = cpuRuntime.readMemoryTranscriptStatsInWorker;
    const reading = vi
      .spyOn(cpuRuntime, "readMemoryTranscriptStatsInWorker")
      .mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        delivered.resolve();
        await release.promise;
        return result;
      });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
    );
    const sync = vi.spyOn(manager, "sync");
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await delivered.promise;
      closing = manager.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(sync).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await closing;
      sync.mockRestore();
      reading.mockRestore();
    }
  });

  it.each(["ready", "rejected"] as const)(
    "waits for a %s cache read before requesting embeddings",
    async (outcome) => {
      const memoryPath = path.join(fixture.paths.memory, "2026-01-12.md");
      await fs.writeFile(memoryPath, "Published alpha cache-read source.");
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "openai",
          sources: ["memory"],
          cacheEnabled: true,
          vectorEnabled: false,
        }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      const database = Reflect.get(manager, "publishedDatabase") as MemoryIndexDatabase;
      const publishedDb = database.db;
      const before = publishedDb.prepare("SELECT text FROM memory_index_chunks ORDER BY id").all();
      const replacement = "Replacement beta after the cache read.";
      await fs.writeFile(memoryPath, replacement);
      fixture.provider.embeddedBatchTexts = [];
      const delivered = createDeferred<void>();
      const release = createDeferred<void>();
      let readDelivered = false;
      const read = database.read.bind(database);
      const reading = vi
        .spyOn(database, "read")
        .mockImplementation(async (command, assertCurrent) => {
          const result = await read(command, assertCurrent);
          if (command.type === "cache.read") {
            readDelivered = true;
            delivered.resolve();
            await release.promise;
            if (outcome === "rejected") {
              throw new Error("controlled cache read rejection");
            }
          }
          return result;
        });
      const sync = manager.sync({ reason: "delayed-cache", force: true });
      void sync.catch(() => undefined);
      try {
        await Promise.race([delivered.promise, sync]);
        expect(readDelivered).toBe(true);
        expect(fixture.provider.embeddedBatchTexts).toEqual([]);
        expect(
          publishedDb.prepare("SELECT text FROM memory_index_chunks ORDER BY id").all(),
        ).toEqual(before);
        release.resolve();
        if (outcome === "ready") {
          await sync;
          expect(fixture.provider.embeddedBatchTexts).toEqual([replacement]);
        } else {
          await expect(sync).rejects.toThrow("controlled cache read rejection");
          expect(fixture.provider.embeddedBatchTexts).toEqual([]);
        }
        const current = openOpenClawAgentDatabase({ agentId: "main" }).db;
        expect(current.prepare("SELECT text FROM memory_index_chunks ORDER BY id").all()).toEqual(
          outcome === "ready" ? [{ text: replacement }] : before,
        );
      } finally {
        release.resolve();
        await sync.catch(() => undefined);
        reading.mockRestore();
      }
    },
  );

  it.each(["ready", "rejected", "revoked"] as const)(
    "settles a %s source-hash read before replacing the session index",
    async (outcome) => {
      const sessionId = "source-hash-admission";
      const sessionKey = `agent:main:chat:${sessionId}`;
      const sessionPath = `sessions/main/${sessionId}.jsonl`;
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: 1, content: "Published violet source." }],
      });
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "none",
          sources: ["sessions"],
          sessionMemory: true,
          vectorEnabled: false,
        }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      const observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
        readOnly: true,
      });
      const snapshot = () => readPublishedSessionIndex(observer, sessionPath, "violet");
      const before = snapshot();
      expect(before.chunks).toHaveLength(1);
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", timestamp: 2, content: "Replacement violet response." }],
      });
      const database = Reflect.get(manager, "publishedDatabase") as MemoryIndexDatabase;
      const observed = outcome === "ready" ? observePublishedSql(database.db) : undefined;
      const hashReads = () =>
        observed
          ?.calls()
          .filter(({ sql }) =>
            /^\s*SELECT\s+["`]?hash["`]?\s+FROM\s+["`]?memory_index_sources\b/i.test(sql),
          );
      if (observed) {
        database.db.prepare("SELECT hash FROM memory_index_sources WHERE 0").all();
        expect(hashReads()).toHaveLength(1);
        observed.clear();
      }
      const delivered = createDeferred<void>();
      const release = createDeferred<void>();
      let readDelivered = false;
      const read = database.read.bind(database);
      const reading = vi
        .spyOn(database, "read")
        .mockImplementation(async (command, assertCurrent) => {
          const result = await read(command, assertCurrent);
          if (command.type === "source.hash") {
            expect(result).toBe(before.source?.hash);
            readDelivered = true;
            delivered.resolve();
            await release.promise;
            if (outcome === "rejected") {
              throw new Error("controlled source-hash read rejection");
            }
          }
          return result;
        });
      const sync = manager.sync({
        reason: "delayed-source",
        sessions: [{ sessionId, sessionKey }],
      });
      void sync.catch(() => undefined);
      try {
        await Promise.race([delivered.promise, sync]);
        expect(readDelivered).toBe(true);
        expect(snapshot()).toEqual(before);
        if (outcome === "revoked") {
          closeOpenClawAgentDatabasesForTest();
        }
        release.resolve();
        if (outcome === "ready") {
          await sync;
          expect(hashReads()).toEqual([]);
          const after = snapshot();
          expect(after.source?.hash).not.toBe(before.source?.hash);
          expect(after.chunks.map((row) => row.text).join("\n")).toContain(
            "Replacement violet response.",
          );
          expect(after.search.length).toBeGreaterThan(0);
        } else {
          await expect(sync).rejects.toThrow(
            outcome === "rejected"
              ? "controlled source-hash read rejection"
              : "Memory database owner closed or changed before write admission",
          );
          expect(snapshot()).toEqual(before);
        }
      } finally {
        release.resolve();
        await sync.catch(() => undefined);
        reading.mockRestore();
        observed?.restore();
        observer.close();
      }
    },
  );
});
