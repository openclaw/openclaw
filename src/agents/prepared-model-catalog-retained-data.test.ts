import { expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareProviderStaticCatalog } from "../plugins/provider-discovery.js";
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
