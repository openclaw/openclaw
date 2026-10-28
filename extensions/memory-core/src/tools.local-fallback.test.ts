import { describe, expect, it } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./memory/manager-index.test-support.js";
import { testing } from "./tools.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

describe("memory_search local provider degradation", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([false, true])(
    "preserves keyword fallback and real identity errors after transport failure (mismatch: %s)",
    async (mismatch) => {
      testing.resetMemorySearchToolCooldowns();
      const originalAliasProvider = fixture.provider.identityAlias.provider;
      fixture.provider.identityAlias.provider = "local";
      try {
        const model = fixture.provider.identityAlias.canonicalModel;
        const cfg = fixture.createConfig({ provider: "local", model, fallback: "none" });
        const manager = await fixture.getFreshManager(cfg);
        await manager.sync({ reason: "test" });
        const tool = createMemorySearchToolOrThrow({ config: cfg, agentId: "main" });
        const healthy = await tool.execute("healthy", { query: "alpha", corpus: "memory" });
        expect(healthy.details).toMatchObject({
          results: [expect.objectContaining({ path: "memory/2026-01-12.md" })],
          provider: "local",
        });
        fixture.provider.beforeEmbedQuery = async () => {
          throw new Error("HTTP 400: synthetic embedding transport failure");
        };

        const failed = await tool.execute("transport-failure", {
          query: "zebra",
          corpus: "memory",
        });
        expect(manager.status().custom?.providerState).toMatchObject({
          mode: "degraded",
          providerId: "local",
          reason: expect.stringContaining("synthetic embedding transport failure"),
        });
        expect(failed.details).not.toHaveProperty("disabled");
        expect(failed.details).toMatchObject({
          results: [expect.objectContaining({ path: "memory/2026-01-12.md" })],
        });
        if (mismatch) {
          // Search retains its captured generation; seed offline corruption after its owner closes.
          const db = memoryIndexFixtureWriter(manager);
          await manager.close();
          db.prepare(
            "UPDATE memory_index_meta SET value = json_set(value, '$.model', ?) WHERE key = 'memory_index_meta_v1'",
          ).run("different-embedding-model");
          const mismatched = await tool.execute("persisted-identity-mismatch", {
            query: "zebra",
            corpus: "memory",
          });
          expect(mismatched.details).toMatchObject({
            results: [],
            disabled: true,
            unavailable: true,
            error: `index was built for model different-embedding-model, expected ${model}`,
          });
          return;
        }
        fixture.provider.beforeEmbedQuery = null;
        const repeated = await tool.execute("after-transport-restored", {
          query: "alpha zebra",
          corpus: "memory",
        });
        expect(repeated.details).not.toHaveProperty("disabled");
        expect(repeated.details).toMatchObject({
          results: [expect.objectContaining({ path: "memory/2026-01-12.md" })],
        });
      } finally {
        fixture.provider.identityAlias.provider = originalAliasProvider;
      }
    },
  );
});
