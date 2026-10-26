import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadSqliteVecExtension,
  openOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  captureOpenClawAgentDatabaseExecution,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const schemaRead =
  /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:encoding|user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b/iu;
const statusRead =
  /memory_index_|memory_embedding_cache|sqlite_(?:schema|master)|\b(?:pragma_)?(?:table_info|table_xinfo|table_list|foreign_key_list|index_list|index_info)\b/i;
const vectorTable = "memory_index_chunks_vec";
const main = { agentId: "main" };

function observeSql(predicate: (sql: string) => boolean) {
  const queries: string[] = [];
  const observed = observeHostDataSql((sql) => {
    if (predicate(sql)) {
      queries.push(sql);
    }
  });
  return { queries, [Symbol.dispose]: () => observed.restore() };
}

describe("memory index schema admission", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("reports an uninitialized status without creating agent or registry databases", async () => {
    const agentPath = resolveOpenClawAgentSqlitePath(main);
    const statePath = path.join(fixture.paths.stateDir, "state", "openclaw.sqlite");
    using observed = observeSql((sql) => statusRead.test(sql));
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: fixture.createConfig({
        cacheEnabled: true,
        sources: ["memory", "sessions"],
        sessionMemory: true,
      }),
      ...main,
      purpose: "status",
      inspectSources: true,
    });
    const manager = result.manager;
    try {
      expect(result.error).toBeUndefined();
      assert(manager, "Expected an uninitialized status manager");
      await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
      expect(manager.status()).toMatchObject({
        files: 0,
        chunks: 0,
        dirty: true,
        cache: { enabled: true, entries: 0 },
        vector: { index: { state: "empty" } },
        storage: {
          databaseBytes: 0,
          walBytes: 0,
          embeddingCacheBytes: 0,
          embeddingCacheEntries: 0,
        },
        custom: { indexIdentity: { status: "missing" } },
      });
      await manager.close?.();
      expect(observed.queries).toEqual([]);
      await expect(fs.access(agentPath)).rejects.toThrow("ENOENT");
      await expect(fs.access(statePath)).rejects.toThrow("ENOENT");
    } finally {
      await manager?.close?.();
    }
  });

  it("starts a fresh agent index and makes a subsequent turn searchable", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });
    const agentPath = resolveOpenClawAgentSqlitePath(main);
    await expect(fs.access(agentPath)).rejects.toThrow("ENOENT");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    const canonicalPath = path.join(
      await fs.realpath(path.dirname(agentPath)),
      path.basename(agentPath),
    );
    const creator = captureOpenClawAgentDatabaseExecution(main, {
      expectedCreationIdentity: { key: `path:${canonicalPath}`, canonicalPath },
    });
    try {
      const manager = await fixture.getFreshManager(cfg);
      await fixture.seedSessionTranscript({
        sessionId: "fresh-agent-turn",
        messages: [
          { role: "user", content: "Remember the cobalt telescope.", timestamp: 1 },
          { role: "assistant", content: "Stored the cobalt telescope.", timestamp: 2 },
        ],
      });
      await manager.sync({ reason: "test", force: true });
      expect(await manager.search("cobalt telescope")).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: "sessions" })]),
      );
    } finally {
      await creator.release();
    }
  });

  it.each([false, true])(
    "admits published and shadow schemas off-thread (vectors: %s)",
    async (vectorEnabled) => {
      const cfg = fixture.createConfig({
        provider: vectorEnabled ? "openai" : "none",
        vectorEnabled,
      });
      // Agent boot admission is separate from the memory manager's runtime admission.
      openOpenClawAgentDatabase(main);
      let publishedAdmitted = false;
      using observed = observeSql((sql) =>
        publishedAdmitted
          ? schemaRead.test(sql)
          : new Error().stack?.includes("/memory-schema") === true,
      );
      const schemaSql = observed.queries;
      const manager = await fixture.getFreshManager(cfg, "cli");
      expect.soft(schemaSql.splice(0), "published admission").toEqual([]);
      // Initial reader ownership admission is cold; indexing must not repeat any schema checks.
      publishedAdmitted = true;
      await manager.sync({ reason: "test", force: true });
      expect.soft(schemaSql.splice(0), "shadow admission").toEqual([]);
      expect(await manager.statusAsync()).toMatchObject({
        files: 1,
        fts: { available: true },
        custom: { indexIdentity: { status: "valid" } },
      });
      expect(await manager.search("Zebra")).toEqual([
        expect.objectContaining({ path: "memory/2026-01-12.md" }),
      ]);
      expect.soft(schemaSql, "search after vector publication").toEqual([]);
      if (vectorEnabled) {
        const { db } = openOpenClawAgentDatabase(main);
        expect(tableExists(db, vectorTable)).toBe(true);
      }
    },
  );

  it("retains admission when the publication owner creates vectors on an admitted agent", async () => {
    const database = openOpenClawAgentDatabase(main);
    // Retain quarantine admission too: the observer includes its checks during writer reopen.
    const quarantinePath = path.join(fixture.paths.stateDir, "state", "openclaw-quarantine.sqlite");
    expect(readSqliteDatabaseWriteTokenForPath(quarantinePath)).toBeDefined();
    using quarantine = openNodeSqliteDatabase(quarantinePath, { readOnly: true });
    expect(quarantine.isOpen).toBe(true);
    const loaded = await loadSqliteVecExtension({ db: requireNativeSqliteDatabase(database.db) });
    expect(loaded.ok, loaded.error).toBe(true);
    const reader = openOpenClawAgentDatabaseReadOnly(main, { allowExtension: true });
    assert(reader.found, "Expected an admitted reader");
    const readerDb = reader.database.db;
    const backend = bindSqliteWorkerBackend(
      { kind: "agent" },
      {
        databasePath: database.path,
        database: requireNativeSqliteDatabase(database.db),
        admit: () => {},
      },
    );
    try {
      const readerExtension = await loadSqliteVecExtension({
        db: requireNativeSqliteDatabase(readerDb),
      });
      expect(readerExtension.ok, readerExtension.error).toBe(true);
      expect([database.db, readerDb].map((db) => tableExists(db, vectorTable))).toEqual([
        false,
        false,
      ]);
      const state = {
        vector: { enabled: true, available: true },
        fts: { enabled: false, available: false },
        extensionPath: loaded.extensionPath,
      };
      expect(
        backend.execute({
          type: "vector.ensure",
          input: { dimensions: 2, state },
        }),
      ).toMatchObject({ ok: true, facts: { hasVectorTable: true } });
      using observed = observeSql((sql) => schemaRead.test(sql));
      // The existing reader must receive the catalog before any opener can re-admit it.
      expect(tableExists(readerDb, vectorTable)).toBe(true);
      // A cached open skips admission; retire the writer to exercise receipt adoption.
      database.db.close();
      expect(tableExists(openOpenClawAgentDatabase(main).db, vectorTable)).toBe(true);
      expect(observed.queries).toEqual([]);
      expect(readerDb.prepare(`SELECT count(*) AS count FROM ${vectorTable}`).get()).toEqual({
        count: 0,
      });
    } finally {
      backend.close();
      reader.database.close();
    }
  });

  it("refuses real schema drift when reopening a memory manager", async () => {
    const cfg = fixture.createConfig({ provider: "none", vectorEnabled: false });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.close();
    const { db } = openOpenClawAgentDatabase(main);
    db.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      ...main,
      purpose: "cli",
    });
    expect(result.manager).toBeNull();
    expect(result.error).toContain("canonical memory source identity schema is invalid");
    expect(db.prepare("SELECT name FROM pragma_table_info('memory_index_sources')").all()).toEqual(
      expect.arrayContaining([{ name: "unexpected" }]),
    );
  });
});
