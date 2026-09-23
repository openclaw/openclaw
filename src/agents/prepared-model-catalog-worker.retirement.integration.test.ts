import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as providerRuntime from "../plugins/provider-runtime.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { markPreparedModelRuntimeSnapshotsStale } from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, waitForMarker } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

describe("catalog worker generation retirement", () => {
  it.each([1, 4])("keeps %s settled owner generations idle without a timer", async (agentCount) => {
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
      const fixture = await createFleetFixture(undefined, false, { agentCount });
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

  it("joins a parent capture retired synchronously before its promise is registered", async () => {
    const fixture = await createFleetFixture(undefined, false, { asyncSyntheticAuth: true });
    await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    await loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, { providerIds: [] });
    const hold = path.join(fixture.root, "synthetic-auth-hold");
    const cancelled = path.join(fixture.root, "synthetic-auth-cancel.txt");
    fs.writeFileSync(hold, "");
    const capture = providerRuntime.captureProviderSyntheticAuthFacts;
    const retirement = vi
      .spyOn(providerRuntime, "captureProviderSyntheticAuthFacts")
      .mockImplementationOnce((params) => {
        const pending = capture(params);
        markPreparedModelRuntimeSnapshotsStale(undefined, {
          agentIds: new Set([fixture.agentIds[0]!]),
        });
        return pending;
      });
    let settled = false;
    const request = loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, {
      providerIds: [],
    }).finally(() => {
      settled = true;
    });
    void request.catch(() => {});
    let closing: Promise<void> | undefined;
    try {
      await waitForMarker(cancelled);
      expect(fixture.snapshots[0]!.isCurrent()).toBe(false);
      expect(fixture.snapshots[1]!.isCurrent()).toBe(true);
      expect(settled).toBe(false);
      let closed = false;
      closing = closePreparedModelRuntimeSnapshots().then(() => {
        closed = true;
      });
      await checkpoint();
      expect(closed).toBe(false);
      fs.rmSync(hold);
      await expect(request).rejects.toThrow("superseded");
      await closing;
      expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
    } finally {
      fs.rmSync(hold, { force: true });
      await Promise.allSettled([request, closing]);
      retirement.mockRestore();
    }
  });
});
