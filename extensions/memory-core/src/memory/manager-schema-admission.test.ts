import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

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

  it("admits the published and shadow schemas without caller-thread schema SQL", async () => {
    const cfg = fixture.createConfig({ provider: "none", vectorEnabled: false });
    // Agent boot admission is separate from the memory manager's runtime admission.
    openOpenClawAgentDatabase({ agentId: "main" });
    const schemaSql: string[] = [];
    const observed = observeHostDataSql((sql) => {
      if (new Error().stack?.includes("/memory-schema")) {
        schemaSql.push(sql);
      }
    });
    try {
      const manager = await fixture.getFreshManager(cfg, "cli");
      expect.soft(schemaSql.splice(0), "published admission").toEqual([]);
      await manager.sync({ reason: "test", force: true });
      expect.soft(schemaSql.splice(0), "shadow admission").toEqual([]);
      expect(manager.status()).toMatchObject({
        files: 1,
        fts: { available: true },
        custom: { indexIdentity: { status: "valid" } },
      });
      expect(await manager.search("Zebra")).toEqual([
        expect.objectContaining({ path: "memory/2026-01-12.md" }),
      ]);
    } finally {
      observed.restore();
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
