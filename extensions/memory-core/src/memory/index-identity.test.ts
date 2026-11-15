import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { expect, it } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";

const {
  provider: providerFixture,
  createConfig: createCfg,
  getFreshManager,
} = createManagerIndexFixture(await import("./index.js"));
const { provider, canonicalModel, cacheModel } = providerFixture.identityAlias;
const config = (model: string) =>
  createCfg({
    provider,
    model,
    cacheEnabled: true,
    vectorEnabled: false,
  });

function rewritePersistedProviderIdentity(manager: MemoryIndexManager, model: string): void {
  const providerKey = hashText(JSON.stringify({ provider, model }));
  const db = memoryIndexFixtureWriter(manager);
  const metaRow = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
    .get("memory_index_meta_v1");
  const meta = JSON.parse(String(metaRow?.value ?? "{}")) as MemoryIndexMeta;
  db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?").run(
    JSON.stringify({ ...meta, model, providerKey }),
    "memory_index_meta_v1",
  );
  db.prepare("UPDATE memory_index_chunks SET model = ?").run(model);
  db.prepare(
    "UPDATE memory_embedding_cache SET model = ?, provider_key = ? WHERE provider = ?",
  ).run(model, providerKey, provider);
}

it.each([
  [canonicalModel, cacheModel],
  [cacheModel, canonicalModel],
])(
  "keeps indexes and embedding caches usable from %s to %s",
  async (indexedModel, configuredModel) => {
    const indexedManager = await getFreshManager(config(canonicalModel));
    await indexedManager.sync({ reason: "test", force: true });
    if (indexedModel !== canonicalModel) {
      rewritePersistedProviderIdentity(indexedManager, indexedModel);
    }
    await indexedManager.close?.();

    const embedsBeforeReuse = providerFixture.embedBatchCalls;
    const nextCfg = config(configuredModel);
    const providerCallsBeforeStatus = providerFixture.providerCalls.length;
    const statusManager = await getFreshManager(nextCfg, "status");
    expect(statusManager.status()).toMatchObject({
      dirty: false,
      provider,
      model: canonicalModel,
      custom: {
        indexIdentity: { status: "valid" },
        providerState: {
          mode: "pending",
          requestedProvider: provider,
        },
      },
    });
    expect(providerFixture.providerCalls).toHaveLength(providerCallsBeforeStatus);
    await statusManager.close?.();

    const nextManager = await getFreshManager(nextCfg);
    const results = await nextManager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    await nextManager.sync({ reason: "test", force: true });
    expect(providerFixture.embedBatchCalls).toBe(embedsBeforeReuse);
    await nextManager.close?.();
  },
);
