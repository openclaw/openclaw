import { describe, it } from "vitest";
import { expectNativeHarnessModelsPublishedFromWorker } from "./prepared-model-catalog-worker.test-support.js";
import { expectLegacyWorkerCatalogRetention } from "./test-helpers/prepared-model-catalog-legacy-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("prepared native model catalog worker boundary", () => {
  it("retains configured dynamic models alongside native harness models after full refresh", async () => {
    await expectNativeHarnessModelsPublishedFromWorker({ makeTempDir, retireAfterTest });
  });

  it("retains legacy hook rows through consecutive failures without retaining old augmentation rows", async () => {
    await expectLegacyWorkerCatalogRetention({
      makeTempDir,
      retireAfterTest,
      catalogReturnsRows: true,
    });
  });

  it("publishes fresh augmentation rows after a configured-only worker acquisition fails", async () => {
    await expectLegacyWorkerCatalogRetention({
      makeTempDir,
      retireAfterTest,
      catalogReturnsRows: false,
    });
  });

  it("retains a legacy catalog returned only under a registered provider alias", async () => {
    await expectLegacyWorkerCatalogRetention({
      makeTempDir,
      retireAfterTest,
      catalogReturnsRows: true,
      aliasOnly: true,
    });
  });
});
