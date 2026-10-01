import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";

// Install the fixture's embedding mocks before loading the manager.
const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index identity", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager } = fixture;

  function rewritePersistedProviderIdentity(manager: MemoryIndexManager, model: string): void {
    const providerKey = hashText(
      JSON.stringify({
        provider: providerFixture.identityAlias.provider,
        model,
      }),
    );
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => {
        get: (...params: unknown[]) => { value?: string } | undefined;
        run: (...params: unknown[]) => void;
      };
    };
    const metaRow = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get("memory_index_meta_v1");
    const meta = JSON.parse(metaRow?.value ?? "{}") as MemoryIndexMeta;
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?").run(
      JSON.stringify({ ...meta, model, providerKey }),
      "memory_index_meta_v1",
    );
    db.prepare("UPDATE memory_index_chunks SET model = ?").run(model);
    db.prepare(
      "UPDATE memory_embedding_cache SET model = ?, provider_key = ? WHERE provider = ?",
    ).run(model, providerKey, providerFixture.identityAlias.provider);
  }

  it.each([
    {
      direction: "HF to exact cache path",
      indexedModel: providerFixture.identityAlias.canonicalModel,
      configuredModel: providerFixture.identityAlias.cacheModel,
    },
    {
      direction: "exact cache path to HF",
      indexedModel: providerFixture.identityAlias.cacheModel,
      configuredModel: providerFixture.identityAlias.canonicalModel,
    },
  ])(
    "keeps $direction indexes and embedding caches usable",
    async ({ indexedModel, configuredModel }) => {
      const indexedCfg = createCfg({
        provider: providerFixture.identityAlias.provider,
        model: providerFixture.identityAlias.canonicalModel,
        cacheEnabled: true,
        vectorEnabled: false,
      });
      const indexedManager = await getFreshManager(indexedCfg);
      await indexedManager.sync({ reason: "test", force: true });
      if (indexedModel !== providerFixture.identityAlias.canonicalModel) {
        rewritePersistedProviderIdentity(indexedManager, indexedModel);
      }
      await indexedManager.close?.();

      const embedsBeforeReuse = providerFixture.embedBatchCalls;
      const nextCfg = createCfg({
        provider: providerFixture.identityAlias.provider,
        model: configuredModel,
        cacheEnabled: true,
        vectorEnabled: false,
      });
      const providerCallsBeforeStatus = providerFixture.providerCalls.length;
      const statusManager = await getFreshManager(nextCfg, "status");
      try {
        expect(statusManager.status()).toMatchObject({
          dirty: false,
          provider: providerFixture.identityAlias.provider,
          model: providerFixture.identityAlias.canonicalModel,
          custom: {
            indexIdentity: { status: "valid" },
            providerState: {
              mode: "pending",
              requestedProvider: providerFixture.identityAlias.provider,
            },
          },
        });
        expect(providerFixture.providerCalls).toHaveLength(providerCallsBeforeStatus);
      } finally {
        await statusManager.close?.();
      }

      const nextManager = await getFreshManager(nextCfg);
      try {
        const results = await nextManager.search("zebra");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.path).toContain("memory/2026-01-12.md");
        expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

        await nextManager.sync({ reason: "test", force: true });

        expect(providerFixture.embedBatchCalls).toBe(embedsBeforeReuse);
      } finally {
        await nextManager.close?.();
      }
    },
  );
});
