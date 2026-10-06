import { describe, it } from "vitest";
import { expectNativeHarnessModelsPublishedFromWorker } from "./prepared-model-catalog-worker.test-support.js";
import { expectLegacyWorkerCatalogRetention } from "./test-helpers/prepared-model-catalog-legacy-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("prepared native model catalog worker boundary", () => {
  it("retains configured dynamic models alongside native harness models after full refresh", async () => {
    await expectNativeHarnessModelsPublishedFromWorker({ makeTempDir, retireAfterTest });
  });

  it.each([
    { catalogReturnsRows: true, aliasOnly: false },
    { catalogReturnsRows: false, aliasOnly: false },
    { catalogReturnsRows: true, aliasOnly: true },
  ])("refreshes legacy catalogs (rows=$catalogReturnsRows, alias=$aliasOnly)", async (options) => {
    await expectLegacyWorkerCatalogRetention({
      makeTempDir,
      retireAfterTest,
      ...options,
    });
  });
});
