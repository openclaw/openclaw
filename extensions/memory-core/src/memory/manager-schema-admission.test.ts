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
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index schema admission", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("reports an uninitialized status without creating agent or registry databases", async () => {
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const statePath = path.join(fixture.paths.stateDir, "state", "openclaw.sqlite");
    const observed = observeHostDataSql();
    let manager: Awaited<ReturnType<typeof getMemorySearchManager>>["manager"] = null;
    try {
      const result = await getMemorySearchManager({
        runInBackgroundContext: runInMemoryTestBackgroundContext,
        cfg: fixture.createConfig({
          cacheEnabled: true,
          sources: ["memory", "sessions"],
          sessionMemory: true,
        }),
        agentId: "main",
        purpose: "status",
        inspectSources: true,
      });
      manager = result.manager;
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
      expect(
        observed.queries.filter((sql) =>
          /memory_index_|memory_embedding_cache|sqlite_(?:schema|master)|\b(?:pragma_)?(?:table_info|table_xinfo|table_list|foreign_key_list|index_list|index_info)\b/i.test(
            sql,
          ),
        ),
      ).toEqual([]);
      await expect(fs.access(agentPath)).rejects.toThrow("ENOENT");
      await expect(fs.access(statePath)).rejects.toThrow("ENOENT");
    } finally {
      try {
        await manager?.close?.();
      } finally {
        observed.restore();
      }
    }
  });

  it("starts a fresh agent index and makes a subsequent turn searchable", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await expect(fs.access(agentPath)).rejects.toThrow("ENOENT");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    const canonicalPath = path.join(
      await fs.realpath(path.dirname(agentPath)),
      path.basename(agentPath),
    );
    const creator = captureOpenClawAgentDatabaseExecution(
      { agentId: "main" },
      {
        expectedCreationIdentity: { key: `path:${canonicalPath}`, canonicalPath },
      },
    );
    try {
      const manager = await fixture.getFreshManager(cfg);
      await fixture.seedSessionTranscript({
        sessionId: "fresh-agent-turn",
        messages: [
          { role: "user", content: "Remember the cobalt telescope.", timestamp: 1 },
          {
            role: "assistant",
            content: "The cobalt telescope is stored in the observatory.",
            timestamp: 2,
          },
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
      openOpenClawAgentDatabase({ agentId: "main" });
      const schemaSql: string[] = [];
      let publishedAdmitted = false;
      const observed = observeHostDataSql((sql) => {
        if (
          publishedAdmitted
            ? /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:encoding|user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b/iu.test(
                sql,
              )
            : new Error().stack?.includes("/memory-schema")
        ) {
          schemaSql.push(sql);
        }
      });
      try {
        const manager = await fixture.getFreshManager(cfg, "cli");
        expect.soft(schemaSql.splice(0), "published admission").toEqual([]);
        // Initial reader ownership admission is cold; indexing must not repeat any schema checks.
        publishedAdmitted = true;
        await manager.sync({ reason: "test", force: true });
        expect.soft(schemaSql.splice(0), "shadow admission").toEqual([]);
        expect(manager.status()).toMatchObject({
          files: 1,
          fts: { available: true },
          custom: { indexIdentity: { status: "valid" } },
        });
        if (vectorEnabled) {
          const { db } = openOpenClawAgentDatabase({ agentId: "main" });
          expect(tableExists(db, "memory_index_chunks_vec")).toBe(true);
          expect.soft(schemaSql.splice(0), "vector schema publication").toEqual([]);
        }
        expect(await manager.search("Zebra")).toEqual([
          expect.objectContaining({ path: "memory/2026-01-12.md" }),
        ]);
        expect.soft(schemaSql, "search after vector publication").toEqual([]);
      } finally {
        observed.restore();
      }
    },
  );

  it("retains admission when the publication owner creates vectors on an admitted agent", async () => {
    const options = { agentId: "main" };
    const database = openOpenClawAgentDatabase(options);
    // Retain quarantine admission too: the observer includes its checks during writer reopen.
    const quarantinePath = path.join(fixture.paths.stateDir, "state", "openclaw-quarantine.sqlite");
    expect(readSqliteDatabaseWriteTokenForPath(quarantinePath)).toBeDefined();
    using quarantine = openNodeSqliteDatabase(quarantinePath, { readOnly: true });
    expect(quarantine.isOpen).toBe(true);
    const loaded = await loadSqliteVecExtension({ db: database.db });
    expect(loaded.ok, loaded.error).toBe(true);
    const reader = openOpenClawAgentDatabaseReadOnly(options, { allowExtension: true });
    assert(reader.found, "Expected an admitted reader");
    const backend = bindSqliteWorkerBackend(
      { kind: "agent" },
      { databasePath: database.path, database: database.db, admit: () => {} },
    );
    try {
      const readerExtension = await loadSqliteVecExtension({ db: reader.database.db });
      expect(readerExtension.ok, readerExtension.error).toBe(true);
      expect(tableExists(database.db, "memory_index_chunks_vec")).toBe(false);
      expect(tableExists(reader.database.db, "memory_index_chunks_vec")).toBe(false);
      expect(
        backend.execute({
          type: "vector.ensure",
          input: {
            dimensions: 2,
            state: {
              vector: { enabled: true, available: true },
              fts: { enabled: false, available: false },
              extensionPath: loaded.extensionPath,
            },
          },
        }),
      ).toMatchObject({ ok: true, facts: { hasVectorTable: true } });
      const schemaSql: string[] = [];
      const observed = observeHostDataSql((sql) => {
        if (
          /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:encoding|user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b/iu.test(
            sql,
          )
        ) {
          schemaSql.push(sql);
        }
      });
      try {
        // The existing reader must receive the catalog before any opener can re-admit it.
        expect(tableExists(reader.database.db, "memory_index_chunks_vec")).toBe(true);
        // A cached open skips admission; retire the writer to exercise receipt adoption.
        database.db.close();
        expect(tableExists(openOpenClawAgentDatabase(options).db, "memory_index_chunks_vec")).toBe(
          true,
        );
        expect(schemaSql).toEqual([]);
      } finally {
        observed.restore();
      }
      expect(
        reader.database.db.prepare("SELECT count(*) AS count FROM memory_index_chunks_vec").get(),
      ).toEqual({ count: 0 });
    } finally {
      backend.close();
      reader.database.close();
    }
  });

  it("refuses real schema drift when reopening a memory manager", async () => {
    const cfg = fixture.createConfig({ provider: "none", vectorEnabled: false });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.close();
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    db.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    expect(result.manager).toBeNull();
    expect(result.error).toContain("canonical memory source identity schema is invalid");
    expect(db.prepare("SELECT name FROM pragma_table_info('memory_index_sources')").all()).toEqual(
      expect.arrayContaining([{ name: "unexpected" }]),
    );
  });
});
