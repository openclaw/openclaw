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

  it("serves keyword results through memory_search while an upgrade rebuild cannot embed", async () => {
    const cfg = fixture.createConfig({ minScore: 0 });
    const filePath = path.join(fixture.paths.memory, "upgrade-fallback.md");
    await fs.writeFile(filePath, "UpgradeKeywordFallback()\nfinish()");
    await seedPriorChunkingVersionIndex(cfg);
    // The changed file forces the upgrade rebuild to request a fresh embedding
    // instead of republishing from the embedding cache.
    await fs.writeFile(
      filePath,
      "UpgradeKeywordFallback() changed after the prior index was published.",
    );
    fixture.provider.embedBatchPermanentFailure = Object.assign(
      new Error("openai embeddings failed: 429 insufficient_quota"),
      { status: 429, code: "insufficient_quota" },
    );

    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      oneShotCliRun: true,
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    try {
      const result = await tool.execute("upgrade-keyword-fallback", {
        query: "UpgradeKeywordFallback",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ path: "memory/upgrade-fallback.md" })],
      });
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("keeps memory_search paused when a pending upgrade has no usable FTS index", async () => {
    const cfg = fixture.createConfig({ minScore: 0 });
    const filePath = path.join(fixture.paths.memory, "upgrade-fts-paused.md");
    await fs.writeFile(filePath, "UpgradeFtsPaused()\nfinish()");
    const dbPath = await seedPriorChunkingVersionIndex(cfg);
    // The changed file forces the upgrade rebuild to request a fresh embedding
    // instead of republishing from the embedding cache.
    await fs.writeFile(filePath, "UpgradeFtsPaused() changed after the prior index was published.");
    // Occupy the FTS table name with a view so every schema ensure — including
    // the upgrade rebuild's republish — fails to restore a usable keyword index.
    const sabotaged = new DatabaseSync(dbPath);
    try {
      sabotaged.exec("DROP TABLE IF EXISTS memory_index_chunks_fts");
      sabotaged.exec("CREATE VIEW memory_index_chunks_fts AS SELECT 1 AS text");
    } finally {
      sabotaged.close();
    }
    fixture.provider.embedBatchPermanentFailure = Object.assign(
      new Error("openai embeddings failed: 429 insufficient_quota"),
      { status: 429, code: "insufficient_quota" },
    );

    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      oneShotCliRun: true,
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    try {
      const result = await tool.execute("upgrade-fts-paused", {
        query: "UpgradeFtsPaused",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [],
        disabled: true,
        unavailable: true,
        error: expect.stringContaining("insufficient_quota"),
        warning: expect.stringContaining("Rebuilding may call the configured embedding provider"),
      });
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("pauses memory_search when a pending upgrade coincides with a changed scope", async () => {
    const wikiPath = path.join(fixture.paths.root, "wiki");
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(wikiPath, "note.md"), "UpgradeScopeWiki alpha note.");
    const cfgWithWiki = fixture.createConfig({ extraPaths: [wikiPath], minScore: 0 });
    const cfgWithoutWiki = fixture.createConfig({ minScore: 0 });
    const filePath = path.join(fixture.paths.memory, "upgrade-scope.md");
    await fs.writeFile(filePath, "UpgradeScopeMemory alpha note.");
    await seedPriorChunkingVersionIndex(cfgWithWiki);
    // The changed file forces the upgrade rebuild to request a fresh embedding;
    // without it the embedding cache satisfies the whole rebuild, which then
    // republishes a valid index under the narrowed scope.
    await fs.writeFile(filePath, "UpgradeScopeMemory note changed after the prior index.");
    fixture.provider.embedBatchPermanentFailure = Object.assign(
      new Error("openai embeddings failed: 429 insufficient_quota"),
      { status: 429, code: "insufficient_quota" },
    );

    const tool = createMemorySearchTool({
      config: cfgWithoutWiki,
      agentId: "main",
      oneShotCliRun: true,
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    try {
      const result = await tool.execute("upgrade-changed-scope", {
        query: "UpgradeScopeMemory",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [],
        disabled: true,
        unavailable: true,
        error: expect.stringContaining("insufficient_quota"),
        warning: expect.stringContaining("Rebuilding may call the configured embedding provider"),
      });
    } finally {
      await closeAllMemorySearchManagers();
      closeOpenClawAgentDatabasesForTest();
    }
  });
});
