import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  sessionPathForSessionIdentity,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import { observeDatabaseReads } from "./manager-read-observation.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager reads", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const sessionConfig = () =>
    fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true });
  const seedSession = (sessionId: string, content: string, senderIsOwner?: boolean) =>
    fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: Date.now(), content, senderIsOwner }],
    });

  it("reports source eligibility before the index exists", async () => {
    const diagnostic = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"] }),
      "status",
      true,
    );
    expect(diagnostic.status().sourceCounts).toMatchObject([
      { source: "memory", files: 0, chunks: 0, eligible: 1, issues: [] },
    ]);
  });

  it("limits targeted archive cleanup to indexed live paths without pruning unrelated sources", async () => {
    const activeId = "active-read-target";
    const archivedId = "archived-read-target";
    for (const sessionId of [activeId, archivedId]) {
      await seedSession(sessionId, `${sessionId} violet memory.`);
    }
    const manager = await fixture.getFreshManager(sessionConfig(), "cli");
    await manager.sync({ reason: "cli", force: true });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:memory:${archivedId}`,
        expectedSessionId: archivedId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const activeArchiveFile = path.join(
      resolveSessionTranscriptsDirForAgent("main"),
      `${activeId}.jsonl.deleted.2026-10-01T00-00-00.000Z`,
    );
    await fs.writeFile(
      activeArchiveFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived cobalt note." },
      }) + "\n",
    );
    const archive = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
      (entry) => entry.sessionId === archivedId,
    );
    expect(archive?.artifactKind).toBe("archive-artifact");
    const database = Reflect.get(manager, "db") as DatabaseSync;
    {
      const writer = memoryIndexFixtureWriter(manager);
      writer.exec("BEGIN IMMEDIATE");
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
      writer.exec("COMMIT");
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
    const observation = observeDatabaseReads(database);
    try {
      await manager.sync({
        reason: "targeted-read-budget",
        sessions: [archivedId, archivedId].map((sessionId) => ({ agentId: "main", sessionId })),
        archiveFiles: [activeArchiveFile, archive!.sessionFile, archive!.sessionFile],
      });
    } finally {
      observation.restore();
    }
    const archivePaths = new Set([activeArchiveFile, archive!.sessionFile].map(sessionPathForFile));
    const after = readSources.all();
    expect(after.filter((row) => !archivePaths.has(String(row.path)))).toEqual(
      before.filter((row) => row.source !== "sessions" || !stalePaths.has(String(row.path))),
    );
    expect(after.filter((row) => archivePaths.has(String(row.path)))).toHaveLength(2);
    expect(await manager.search("violet", { lexicalOnly: true, minScore: 0 })).toContainEqual(
      expect.objectContaining({
        path: sessionPathForSessionIdentity("main", activeId),
        snippet: expect.stringContaining(`${activeId} violet memory.`),
      }),
    );
    const sourceReads = observation.reads.filter(({ sql }) =>
      /\bmemory_index_sources\b/i.test(sql),
    );
    expect(sourceReads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(7);
  });

  it("inspects readonly session corpus diagnostics without changing the published index", async () => {
    const sessionId = "diagnostic-corpus";
    const content = "Violet diagnostic preference remains indexed.";
    await seedSession(sessionId, content, true);
    const cfg = sessionConfig();
    const writer = await fixture.getFreshManager(cfg, "cli");
    await writer.sync({ reason: "diagnostic-baseline", force: true });
    const database: unknown = Reflect.get(writer, "db");
    if (!(database instanceof DatabaseSync)) {
      throw new Error("Expected the fixture's actual published database");
    }
    const rows = (table: string, key: string) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();
    const snapshot = () => ({
      sources: rows("memory_index_sources", "id"),
      chunks: rows("memory_index_chunks", "id"),
      provenance: rows("memory_index_chunk_provenance", "chunk_id"),
      metadata: rows("memory_index_meta", "key"),
      revision: database.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
      nodes: rows("session_nodes", "session_key"),
      windows: rows("session_windows", "session_id"),
    });
    const before = snapshot();
    expect(before).toMatchObject({
      sources: [{ path: sessionPathForSessionIdentity("main", sessionId), source: "sessions" }],
      chunks: [{ source: "sessions", text: expect.stringContaining(content) }],
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

  it("reuses diagnostic cache totals", async () => {
    const cfg = fixture.createConfig({ provider: "none", cacheEnabled: true });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "cli", force: true });
    memoryIndexFixtureWriter(manager)
      .prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('previous', 'previous', 'previous', 'retained', ?, 2, 1)`)
      .run(encodeMemoryEmbedding([1, 2]));
    const ordinary = manager.status();
    expect(ordinary.storage).toBeUndefined();
    expect(ordinary.cache?.entries).toBe(1);
    const diagnostic = await fixture.getFreshManager(cfg, "status", true);
    const diagnosticReads = observeDatabaseReads(Reflect.get(diagnostic, "db") as DatabaseSync);
    try {
      expect(diagnostic.status()).toMatchObject({
        cache: { entries: 1 },
        storage: { embeddingCacheEntries: 1, embeddingCacheBytes: 16 },
      });
      expect(
        diagnosticReads.reads.filter(({ sql }) => /\bmemory_embedding_cache\b/i.test(sql)),
      ).toHaveLength(1);
    } finally {
      diagnosticReads.restore();
      await diagnostic.close();
    }
  });
});
