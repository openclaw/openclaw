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

  it("uses current configured settings when an eligible upgrade rebuild runs", async () => {
    const dbPath = await seedIndex(createConfig("old-model"));
    const manager = await fixture.getFreshManager(createConfig("new-model"));

    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(withDatabase(dbPath, readMeta)).toMatchObject({
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      model: "new-model",
    });
  });

  it("returns lexical results while a failing upgrade keeps the rebuild pending", async () => {
    // batch-test routes document embeddings through the provider runtime, so
    // both injection points below sit on the rebuild's actual embedding path.
    const cfg = fixture.createConfig({ provider: "batch-test", batchEnabled: true });
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg);

    // Change a file so the rebuild requires new embeddings, then make every
    // embedding call fail (simulating quota exhaustion per issue #144493).
    const memoryFile = [fixture.paths.memory, "2026-01-12.md"].join("/");
    await fs.appendFile(memoryFile, "\nNew line requiring re-embedding.\n");
    fixture.provider.providerRuntimeBatchFailuresRemaining = 999;
    fixture.provider.embedBatchFailuresRemaining = 999;

    try {
      // An ordinary search must degrade to keyword hits from the leased
      // published generation instead of returning nothing.
      const results = await manager.search("alpha");
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("2026-01-12") }),
        ]),
      );
      expect(manager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
        code: "chunking_version",
        owner: "openclaw",
      });
      expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
    } finally {
      fixture.provider.providerRuntimeBatchFailuresRemaining = 0;
      fixture.provider.embedBatchFailuresRemaining = 0;
    }
  });

  it("keeps removed extra paths excluded while a chunking upgrade stays pending", async () => {
    // Seed the published index while an extra path is still configured.
    const extraDir = path.join(fixture.paths.root, "excluded-upgrade");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "excluded.md"), "alpha excluded secret workspace notes");
    const seededCfg = fixture.createConfig({
      provider: "batch-test",
      batchEnabled: true,
      extraPaths: [extraDir],
    });
    const dbPath = await seedIndex(seededCfg);

    // Removing the extra path changes the corpus; a stale chunking version
    // must not mask that scope change, or excluded snippets would stay
    // searchable while the rebuild is pending (issue #144493 follow-up).
    const narrowedCfg = fixture.createConfig({
      provider: "batch-test",
      batchEnabled: true,
    });
    const manager = await fixture.getFreshManager(narrowedCfg);
    const memoryFile = [fixture.paths.memory, "2026-01-12.md"].join("/");
    await fs.appendFile(memoryFile, "\nNew line requiring re-embedding.\n");
    fixture.provider.providerRuntimeBatchFailuresRemaining = 999;
    fixture.provider.embedBatchFailuresRemaining = 999;

    try {
      await expect(manager.search("alpha", { lexicalOnly: true })).resolves.toEqual([]);
      expect(manager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
        code: "scope",
        owner: "configuration",
      });
      expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
    } finally {
      fixture.provider.providerRuntimeBatchFailuresRemaining = 0;
      fixture.provider.embedBatchFailuresRemaining = 0;
    }
  });
});
