import { describe, expect, it, vi } from "vitest";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

describe("catalog worker generation retirement", () => {
  it("keeps settled fleet generations idle without a timer", async () => {
    const createWorker = catalogWorker.createPreparedModelCatalogWorker;
    let checks = 0;
    const observe = vi
      .spyOn(catalogWorker, "createPreparedModelCatalogWorker")
      .mockImplementation((params) =>
        createWorker({
          ...params,
          isCurrent: () => {
            checks += 1;
            return params.isCurrent();
          },
        }),
      );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const fixture = await createFleetFixture();
      await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
      await Promise.all(
        fixture.snapshots.map((snapshot) =>
          loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
        ),
      );
      expect(catalogWorker.getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
      const settledChecks = checks;
      await vi.advanceTimersByTimeAsync(100);
      expect(checks).toBe(settledChecks);
    } finally {
      await closePreparedModelRuntimeSnapshots();
      vi.useRealTimers();
      observe.mockRestore();
    }
  });
});
