import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search after a chunking upgrade", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  function createConfig(model = "mock-embed") {
    return fixture.createConfig({ model, vectorEnabled: false });
  }

  function withDatabase<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  function readMeta(db: DatabaseSync): MemoryIndexMeta {
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get();
    if (typeof row?.value !== "string") {
      throw new Error("fixture index metadata is missing");
    }
    return JSON.parse(row.value) as MemoryIndexMeta;
  }

  async function seedIndex(
    cfg: ReturnType<typeof createConfig>,
    oldChunkingVersion = true,
  ): Promise<string> {
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const dbPath = manager.status().dbPath;
    if (!dbPath) {
      throw new Error("fixture database path is missing");
    }
    await manager.close();
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    if (oldChunkingVersion) {
      // Keep real indexed files unchanged, but reopen the publication as an older runtime's index.
      withDatabase(dbPath, (db) => {
        const meta = readMeta(db);
        db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
          JSON.stringify({ ...meta, chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }),
        );
      });
    }
    return dbPath;
  }

  it.each(["default", "cli"] as const)(
    "rebuilds unchanged prior-version content on the first %s search",
    async (purpose) => {
      const cfg = createConfig();
      const dbPath = await seedIndex(cfg);
      const manager = await fixture.getFreshManager(cfg, purpose);

      const results = await manager.search("alpha", { lexicalOnly: true });

      expect(results).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION);
    },
  );

  it("keeps status inspection read-only during an upgrade", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg, "status");

    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: "chunking_version",
      owner: "openclaw",
    });
    expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
  });

  it("preserves configuration-only mismatch behavior", async () => {
    await seedIndex(createConfig("old-model"), false);
    const manager = await fixture.getFreshManager(createConfig("new-model"));

    await expect(manager.search("alpha", { lexicalOnly: true })).resolves.toEqual([]);
    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: "model",
      owner: "configuration",
    });
  });

  it("keeps keyword results readable while an upgrade rebuild cannot embed", async () => {
    const cfg = fixture.createConfig({});
    await seedIndex(cfg);
    // The changed file forces the upgrade rebuild to request a fresh embedding.
    await fs.writeFile(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      "# Log\nAlpha memory line changed after the prior index was published.",
    );
    fixture.provider.embedBatchPermanentFailure = Object.assign(
      new Error("openai embeddings failed: 429 insufficient_quota"),
      { status: 429, code: "insufficient_quota" },
    );
    const manager = await fixture.getFreshManager(cfg);
    try {
      const results = await manager.search("alpha");
      expect(results).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      expect(manager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
        code: "chunking_version",
        owner: "openclaw",
        chunkingVersionOnly: true,
      });
    } finally {
      await manager.close();
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("fails closed when a pending upgrade coincides with a changed scope", async () => {
    const wikiPath = path.join(fixture.paths.root, "wiki");
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(wikiPath, "note.md"), "# Wiki\nWiki alpha note.");
    const cfgWithWiki = fixture.createConfig({ extraPaths: [wikiPath] });
    const cfgWithoutWiki = fixture.createConfig({});
    await seedIndex(cfgWithWiki);
    // The changed file forces the upgrade rebuild to request a fresh embedding.
    // Without it the embedding cache satisfies the whole rebuild, which then
    // republishes a valid index under the narrowed scope and never reaches the
    // fail-closed path under test.
    await fs.writeFile(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      "# Log\nAlpha memory line changed after the prior index was published.",
    );
    fixture.provider.embedBatchPermanentFailure = Object.assign(
      new Error("openai embeddings failed: 429 insufficient_quota"),
      { status: 429, code: "insufficient_quota" },
    );
    const manager = await fixture.getFreshManager(cfgWithoutWiki);
    try {
      await expect(manager.search("alpha", { lexicalOnly: true })).resolves.toEqual([]);
      expect(manager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
        code: "chunking_version",
        owner: "openclaw",
      });
      expect(manager.status().custom?.indexIdentity).not.toHaveProperty(
        "chunkingVersionOnly",
        true,
      );
    } finally {
      await manager.close();
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("uses current configured settings when an eligible upgrade rebuild runs", async () => {
    const dbPath = await seedIndex(createConfig("old-model"));
    const manager = await fixture.getFreshManager(createConfig("new-model"));

    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(withDatabase(dbPath, readMeta)).toMatchObject({
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      model: "new-model",
    });
  });
});
