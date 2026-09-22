import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION, type MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

const versions = ["chunkingVersion", "provenanceVersion"] as const;
describe.each(versions)("memory search after a %s upgrade", (versionKey) => {
  const currentVersion =
    versionKey === "chunkingVersion" ? MEMORY_CHUNKING_VERSION : MEMORY_INDEX_PROVENANCE_VERSION;
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
    oldVersion = true,
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
    if (oldVersion) {
      // Keep real indexed files unchanged, but reopen the publication as an older runtime's index.
      withDatabase(dbPath, (db) => {
        const meta = readMeta(db);
        db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
          JSON.stringify({ ...meta, [versionKey]: currentVersion - 1 }),
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
      expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion);
    },
  );

  it("keeps status inspection read-only during an upgrade", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg, "status");

    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: versionKey === "chunkingVersion" ? "chunking_version" : "provenance_version",
      owner: "openclaw",
    });
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion - 1);
  });

  it("rebuilds runtime format changes during ordinary dirty-index synchronization", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "watch" });
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion);
    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
  });

  it("preserves newer indexes during forced background recovery until explicit reindex", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    withDatabase(dbPath, (db) => {
      const meta = readMeta(db);
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify({ ...meta, [versionKey]: currentVersion + 1 }),
      );
    });
    const manager = await fixture.getFreshManager(cfg);
    const embedded = fixture.provider.embedBatchCalls;
    await manager.sync({ reason: "search", force: true });
    expect(await manager.search("alpha", { lexicalOnly: true })).toEqual([]);
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion + 1);
    expect(fixture.provider.embedBatchCalls).toBe(embedded);
    await manager.sync({ reason: "cli", force: true });
    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion);
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
