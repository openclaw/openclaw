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

it("does not rewalk published metadata on idle samples and refreshes replacement roots", () => {
  const first = createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }] });
  const second = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "second" }, { id: "third" }],
  });
  const generation = (pluginMetadataSnapshot: typeof first) => ({
    pluginMetadataSnapshot,
    remoteCatalog: null,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  });
  const firstGeneration = generation(first);
  const secondGeneration = generation(second);
  const initial = measurePreparedCatalogRetainedData([firstGeneration], undefined);
  using observation = vi.spyOn(Object, "getOwnPropertyDescriptor");
  const metadataReads = () =>
    observation.mock.calls.filter(([value]) => value === first || value === second).length;
  for (let heartbeat = 0; heartbeat < 20; heartbeat++) {
    expect(measurePreparedCatalogRetainedData([firstGeneration], undefined)).toEqual(initial);
  }
  expect(metadataReads()).toBe(0);
  const combined = measurePreparedCatalogRetainedData(
    [firstGeneration, secondGeneration],
    undefined,
  );
  expect(metadataReads()).toBeGreaterThan(0);
  expect(combined).toContainEqual(
    expect.objectContaining({ structure: "catalog-metadata", entries: 2 }),
  );
  observation.mockClear();
  const replaced = measurePreparedCatalogRetainedData([secondGeneration], undefined);
  expect(metadataReads()).toBeGreaterThan(0);
  expect(replaced).toContainEqual(
    expect.objectContaining({ structure: "catalog-metadata", entries: 1 }),
  );
  expect(
    replaced.find((row) => row.structure === "catalog-metadata")?.approximateBytes,
  ).toBeGreaterThan(initial.find((row) => row.structure === "catalog-metadata")!.approximateBytes);
});
