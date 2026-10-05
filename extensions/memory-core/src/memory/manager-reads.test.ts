import { DatabaseSync } from "node:sqlite";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  sessionPathForSessionIdentity,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function observeReads(database: DatabaseSync) {
  const reads: Array<{ sql: string; rows: number }> = [];
  const prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "get").mockImplementation((...bindings) => {
      const row = get(...bindings);
      reads.push({ sql, rows: row ? 1 : 0 });
      return row;
    });
    vi.spyOn(statement, "all").mockImplementation((...bindings) => {
      const rows = all(...bindings);
      reads.push({ sql, rows: rows.length });
      return rows;
    });
    vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
      const read = { sql, rows: 0 };
      reads.push(read);
      for (const row of iterate(...bindings)) {
        read.rows += 1;
        yield row;
      }
      return undefined;
    });
    return statement;
  });
  return { reads, restore: () => spy.mockRestore() };
}

describe("memory manager reads", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("reports source eligibility before the index exists", async () => {
    const diagnostic = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"] }),
      "status",
      true,
    );
    expect(diagnostic.status().sourceCounts).toMatchObject([
      {
        source: "memory",
        files: 0,
        chunks: 0,
        eligible: 1,
        issues: [],
      },
    ]);
  });

  it("limits targeted archive cleanup to indexed live paths without pruning unrelated sources", async () => {
    const activeId = "active-read-target";
    const archivedId = "archived-read-target";
    for (const sessionId of [activeId, archivedId]) {
      await fixture.seedSessionTranscript({
        sessionId,
        messages: [{ role: "user", timestamp: Date.now(), content: `${sessionId} violet memory.` }],
      });
    }
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:memory:${archivedId}`,
        expectedSessionId: archivedId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const archive = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
      (entry) => entry.sessionId === archivedId,
    );
    expect(archive?.artifactKind).toBe("archive-artifact");
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const databasePath = database.location();
    if (!databasePath) {
      throw new Error("Expected the fixture's file-backed memory index");
    }
    {
      // Observe the worker-published schema before seeding through a fixture writer.
      using writer = new DatabaseSync(databasePath);
      const insert = writer.prepare(
        "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES(?, ?, 'retained', 1, 2)",
      );
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`sessions/main/unrelated-${index}.jsonl`, "sessions");
      }
      for (const sessionId of [activeId, archivedId]) {
        insert.run(`sessions/main/${sessionId}`, "sessions");
      }
      insert.run(`sessions/main/${archivedId}`, "memory");
    }
    const readSources = database.prepare(
      "SELECT * FROM memory_index_sources ORDER BY path, source",
    );
    const before = readSources.all();
    const stalePaths = new Set([
      sessionPathForSessionIdentity("main", archivedId),
      `sessions/main/${activeId}`,
      `sessions/main/${archivedId}`,
    ]);
    const observation = observeReads(database);
    try {
      await manager.sync({
        reason: "targeted-read-budget",
        sessions: [activeId, archivedId, activeId].map((sessionId) => ({
          agentId: "main",
          sessionId,
        })),
        archiveFiles: [archive!.sessionFile, archive!.sessionFile],
      });
    } finally {
      observation.restore();
    }
    const archivePath = sessionPathForFile(archive!.sessionFile);
    const after = readSources.all();
    expect(after.filter((row) => row.path !== archivePath)).toEqual(
      before.filter((row) => row.source !== "sessions" || !stalePaths.has(String(row.path))),
    );
    expect(after.some((row) => row.path === archivePath && row.source === "sessions")).toBe(true);
    const sourceReads = observation.reads.filter(({ sql }) =>
      /\bmemory_index_sources\b/i.test(sql),
    );
    expect(sourceReads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(7);
  });

  it("inspects readonly session corpus diagnostics without changing the published index", async () => {
    const sessionId = "diagnostic-corpus";
    await fixture.seedSessionTranscript({
      sessionId,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: "Violet diagnostic preference remains indexed.",
          senderIsOwner: true,
        },
      ],
    });
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["sessions"],
      sessionMemory: true,
    });
    const writer = await fixture.getFreshManager(cfg, "cli");
    await writer.sync({ reason: "diagnostic-baseline", force: true });
    const database: unknown = Reflect.get(writer, "db");
    if (!(database instanceof DatabaseSync)) {
      throw new Error("Expected the fixture's actual published database");
    }
    const snapshot = () => ({
      sources: database.prepare("SELECT * FROM memory_index_sources ORDER BY id").all(),
      chunks: database.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
      provenance: database
        .prepare("SELECT * FROM memory_index_chunk_provenance ORDER BY chunk_id")
        .all(),
      metadata: database.prepare("SELECT * FROM memory_index_meta ORDER BY key").all(),
      revision: database.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
      nodes: database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
      windows: database.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
    });
    const before = snapshot();
    expect(before.sources).toHaveLength(1);
    expect(before.sources[0]).toMatchObject({
      path: sessionPathForSessionIdentity("main", sessionId),
      source: "sessions",
    });
    expect(before.chunks).toHaveLength(1);
    expect(before.chunks[0]).toMatchObject({
      source: "sessions",
      text: expect.stringContaining("Violet diagnostic preference remains indexed."),
    });

    const diagnostic = await fixture.getFreshManager(cfg, "status", true);
    try {
      expect(diagnostic.status()).toMatchObject({
        files: 1,
        chunks: 1,
        sourceCounts: [{ source: "sessions", files: 1, chunks: 1, eligible: 1, issues: [] }],
      });
      expect(snapshot()).toEqual(before);
    } finally {
      await diagnostic.close();
    }
    expect(database.isOpen).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("reuses diagnostic cache totals and the synchronous sync existence check", async () => {
    const cfg = fixture.createConfig({ provider: "none", cacheEnabled: true });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "cli", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    database
      .prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('previous', 'previous', 'previous', 'retained', ?, 2, 1)`)
      .run(encodeMemoryEmbedding([1, 2]));
    const ordinary = manager.status();
    expect(ordinary.storage).toBeUndefined();
    expect(ordinary.cache?.entries).toBe(1);
    const diagnostic = await fixture.getFreshManager(cfg, "status", true);
    const diagnosticReads = observeReads(Reflect.get(diagnostic, "db") as DatabaseSync);
    try {
      const inspected = diagnostic.status();
      expect(inspected.cache?.entries).toBe(1);
      expect(inspected.storage).toMatchObject({
        embeddingCacheEntries: 1,
        embeddingCacheBytes: 16,
      });
      expect(
        diagnosticReads.reads.filter(({ sql }) => /\bmemory_embedding_cache\b/i.test(sql)),
      ).toHaveLength(1);
    } finally {
      diagnosticReads.restore();
      await diagnostic.close();
    }
    const syncReads = observeReads(database);
    try {
      await manager.sync({ reason: "cli" });
      expect(
        syncReads.reads.filter(({ sql }) => /\bmemory_index_chunks\b/i.test(sql)),
      ).toHaveLength(1);
    } finally {
      syncReads.restore();
    }
  });
});
