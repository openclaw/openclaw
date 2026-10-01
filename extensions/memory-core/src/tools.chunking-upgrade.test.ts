import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

describe("memory_search during a chunking upgrade", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  beforeEach(() => {
    testing.resetMemorySearchToolCooldowns();
  });

  // Seeds a published index, then reopens its metadata as an older runtime's
  // index so the next search sees a pending OpenClaw chunking upgrade.
  async function seedPriorChunkingVersionIndex(
    cfg: Parameters<typeof fixture.getFreshManager>[0],
  ): Promise<string> {
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const dbPath = manager.status().dbPath;
    if (!dbPath) {
      throw new Error("memory search manager database path missing");
    }
    await manager.close();
    await closeAllMemorySearchManagers();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get();
      if (typeof row?.value !== "string") {
        throw new Error("fixture index metadata is missing");
      }
      const meta = JSON.parse(row.value) as Record<string, unknown>;
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify({ ...meta, chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }),
      );
    } finally {
      db.close();
    }
    return dbPath;
  }

  it.each(["keyword fallback", "missing FTS", "changed scope"] as const)(
    "handles an upgrade with %s",
    async (scenario) => {
      const cfg = fixture.createConfig({ minScore: 0 });
      const filePath = path.join(fixture.paths.memory, "upgrade.md");
      await fs.writeFile(filePath, "UpgradeKeywordFallback alpha note.");
      let indexedConfig = cfg;
      if (scenario === "changed scope") {
        const wikiPath = path.join(fixture.paths.root, "wiki");
        await fs.mkdir(wikiPath, { recursive: true });
        await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
        indexedConfig = fixture.createConfig({ extraPaths: [wikiPath], minScore: 0 });
      }
      const dbPath = await seedPriorChunkingVersionIndex(indexedConfig);
      // A changed file prevents the embedding cache from satisfying the rebuild.
      await fs.writeFile(filePath, "UpgradeKeywordFallback changed after publication.");
      if (scenario === "missing FTS") {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
          db.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
        } finally {
          db.close();
        }
      }
      fixture.provider.embedBatchPermanentFailure = Object.assign(
        new Error("openai embeddings failed: 429 insufficient_quota"),
        { status: 429, code: "insufficient_quota" },
      );
      const tool = createMemorySearchTool({ config: cfg, agentId: "main", oneShotCliRun: true });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      try {
        const result = await tool.execute("upgrade", {
          query: "UpgradeKeywordFallback",
          corpus: "memory",
        });
        expect(result.details).toMatchObject(
          scenario === "keyword fallback"
            ? { results: [expect.objectContaining({ path: "memory/upgrade.md" })] }
            : {
                results: [],
                disabled: true,
                unavailable: true,
                error: expect.stringContaining("insufficient_quota"),
                warning: expect.stringContaining(
                  "Rebuilding may call the configured embedding provider",
                ),
              },
        );
      } finally {
        await closeAllMemorySearchManagers();
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
