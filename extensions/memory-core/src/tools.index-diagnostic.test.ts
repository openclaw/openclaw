import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMemoryDatabaseRevision } from "./memory/manager-db-kernel.js";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION } from "./memory/manager-reindex-state.js";
import { createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

describe("memory_search retained sync diagnostics", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("keeps newer-index advice after a real failed sync without rewriting the index", async () => {
    testing.resetMemorySearchToolCooldowns();
    const cfg = fixture.createConfig({
      provider: "openai",
      fallback: "none",
      vectorEnabled: false,
    });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const embeddings = await import("./memory/embeddings.js");
    const createProvider = embeddings.createEmbeddingProvider;
    let failSync = false;
    let calls = 0;
    const create = vi
      .spyOn(embeddings, "createEmbeddingProvider")
      .mockImplementation(async (...args) => {
        const result = await createProvider(...args);
        const provider = result.provider;
        if (!provider) {
          throw new Error("fixture embedding provider missing");
        }
        return {
          ...result,
          provider: {
            ...provider,
            embedBatch: async (inputs) => {
              calls += 1;
              if (failSync) {
                throw Object.assign(
                  new Error("HTTP 400: synthetic embedding provider unavailable"),
                  { status: 400 },
                );
              }
              return await provider.embedBatch(inputs);
            },
          },
        };
      });
    try {
      const manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "cli", force: true });
      failSync = true;
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("HTTP 400");
      expect(manager.status().lastSyncError).toContain("HTTP 400");
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(
        "UPDATE memory_index_meta SET value = json_set(value, '$.provenanceVersion', ?) WHERE key = 'memory_index_meta_v1'",
      ).run(MEMORY_INDEX_PROVENANCE_VERSION + 1);
      const before = readMemoryDatabaseRevision(db);
      const chunks = db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
      const priorCalls = calls;
      const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      const result = await tool.execute("newer-after-sync-failure", {
        query: "alpha",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [],
        unavailable: true,
        error: expect.stringContaining("newer OpenClaw"),
        warning: expect.stringContaining("Previous memory sync failed: HTTP 400"),
        action: expect.stringContaining("upgrade OpenClaw or reindex explicitly"),
      });
      expect(manager.status().lastSyncError).toContain("HTTP 400");
      expect(readMemoryDatabaseRevision(db)).toBe(before);
      expect(db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(chunks);
      expect(calls).toBe(priorCalls);
      expect(fixture.provider.embedQueryCalls).toBe(0);
    } finally {
      create.mockRestore();
    }
  });
});
