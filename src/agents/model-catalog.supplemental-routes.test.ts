import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerRuntime from "../plugins/provider-runtime.runtime.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const first: ModelCatalogEntry = {
  provider: "router",
  id: "model",
  name: "Model",
  api: "openai-responses",
  baseUrl: "https://first.example/v1",
  inference: { chat: false },
};
const second: ModelCatalogEntry = {
  ...first,
  name: "Chat",
  inference: { chat: true },
  baseUrl: "https://second.example/v1",
};

async function augment(
  rows: ModelCatalogEntry[],
  supplements: ModelCatalogEntry[],
  readyOrder = true,
) {
  using hook = vi
    .spyOn(providerRuntime, "augmentModelCatalogWithProviderPlugins")
    .mockResolvedValue(supplements);
  const result = await buildPreparedModelCatalogSnapshot({
    config: { plugins: { enabled: false } },
    agentDir: "unused:catalog",
    authCredentials: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    models: rows,
    providerOutcomes: readyOrder
      ? [{ provider: first.provider, status: "ready", modelOrder: [first.id] }]
      : undefined,
  });
  expect(hook).toHaveBeenCalledOnce();
  return result;
}

it.each(["openai-completions", "openai-responses"] as const)(
  "enriches the exact slot while preserving a chat sibling using %s",
  async (api) => {
    const chat = { ...second, api };
    for (const rows of [
      [first, chat],
      [chat, first],
    ]) {
      const enriched = { ...first, baseUrl: first.baseUrl + "/", contextWindow: 64_000 };
      const snapshot = await augment(rows, [enriched]);
      for (const catalog of [snapshot.entries, snapshot.routeVariants]) {
        expect(catalog).toHaveLength(2);
        expect(catalog.find((row) => row.name === first.name)).toMatchObject(enriched);
        expect(findModelInCatalog(catalog, chat.provider, chat.id)).toMatchObject(chat);
      }
    }
  },
);

it("rechecks exact-route ties after a new route retargets the last logical row", async () => {
  const original = { ...first, name: "Original" };
  const partial = {
    provider: first.provider,
    id: first.id,
    name: "Metadata",
    contextWindow: 32_000,
  };
  const snapshot = await augment(
    [original, first],
    [{ ...first, contextWindow: 16_000 }, second, { ...first, contextWindow: 64_000 }, partial],
  );
  expect(snapshot.entries).toHaveLength(2);
  expect(snapshot.entries.find((row) => row.name === original.name)).toMatchObject({
    ...original,
    contextWindow: 64_000,
  });
  expect(snapshot.entries.find((row) => row.name === second.name)).toMatchObject({
    ...second,
    contextWindow: partial.contextWindow,
  });
});

it("keeps supplemental rank when the provider has no published order", async () => {
  const supplement = { ...first, contextWindow: 64_000 };
  const snapshot = await augment([first, second], [supplement], false);
  for (const rows of [snapshot.entries, snapshot.routeVariants]) {
    expect(rows.map((row) => [row.name, row.providerOrder])).toEqual([
      [first.name, 0],
      [second.name, undefined],
    ]);
    expect(findModelInCatalog(rows, first.provider, first.id)).toMatchObject(supplement);
  }
});
