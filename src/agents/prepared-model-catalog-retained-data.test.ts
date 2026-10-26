import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { measurePreparedCatalogRetainedData } from "./prepared-model-catalog-retained-data.js";

it.each(["accessor", "proxy"])("samples a static %s catalog without executing it", async (kind) => {
  let reads = 0;
  const rejectRead = (): never => {
    reads++;
    throw new Error("plugin-owned property executed");
  };
  const config = {
    baseUrl: "https://fixture.invalid",
    get models(): [] {
      return rejectRead();
    },
  };
  const preparedStaticProviderCatalog = await prepareProviderStaticCatalog({
    providers: [
      {
        id: "fixture",
        label: "Fixture",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: kind === "proxy" ? new Proxy(config, { get: rejectRead }) : config,
          }),
        },
      },
    ],
  });
  expect(reads).toBe(0);
  const census = measurePreparedCatalogRetainedData(
    [
      {
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
        remoteCatalog: null,
        inlineProviderModels: [],
        configuredCatalogEntries: [],
        preparedStaticProviderCatalog,
      },
    ],
    undefined,
  );
  expect(reads).toBe(0);
  expect(census.find((row) => row.structure === "catalog-static")).toMatchObject({
    entries: 1,
    providers: 1,
    truncated: true,
  });
});

it("does not rewalk unchanged immutable remote catalogs and refreshes changed roots", () => {
  const catalog = (revision: string, ids: string[]) =>
    freezeJsonSnapshot({
      sourceUrl: "https://catalog.invalid",
      revision,
      generatedAt: 1,
      providers: { fixture: { models: ids.map((id) => ({ id })) } },
      recommendations: {},
      pricing: {},
      upstreamPricing: {},
    });
  const first = catalog("first", ["one"]);
  const second = catalog("second", ["two", "three"]);
  const generation = (remoteCatalog: typeof first) => ({
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    remoteCatalog,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  });
  const firstGeneration = generation(first);
  const secondGeneration = generation(second);
  using observation = vi.spyOn(Object, "getOwnPropertyDescriptor");
  const remoteReads = () =>
    observation.mock.calls.filter(
      ([value]) => value === first.providers || value === second.providers,
    ).length;
  const initial = measurePreparedCatalogRetainedData([firstGeneration], undefined);
  expect(remoteReads()).toBeGreaterThan(0);
  observation.mockClear();
  expect(measurePreparedCatalogRetainedData([firstGeneration], undefined)).toEqual(initial);
  expect(remoteReads()).toBe(0);
  expect(
    measurePreparedCatalogRetainedData([firstGeneration, secondGeneration], undefined),
  ).toContainEqual(
    expect.objectContaining({ structure: "catalog-remote", entries: 3, generations: 2 }),
  );
  expect(remoteReads()).toBeGreaterThan(0);
  expect(measurePreparedCatalogRetainedData([secondGeneration], undefined)).toContainEqual(
    expect.objectContaining({ structure: "catalog-remote", entries: 2, generations: 1 }),
  );
  const mutable = structuredClone(first);
  const mutableGeneration = generation(mutable);
  measurePreparedCatalogRetainedData([mutableGeneration], undefined);
  mutable.providers.fixture.models.push({ id: "added" });
  expect(measurePreparedCatalogRetainedData([mutableGeneration], undefined)).toContainEqual(
    expect.objectContaining({ structure: "catalog-remote", entries: 2, generations: 1 }),
  );
});
