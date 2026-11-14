// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import type { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime-retention" });
const { mocks } = fixture;

it("releases superseded catalog inventories across neutral reloads", async () => {
  mocks.configuredAgentIds = ["default"];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
    entries: [{ provider: "custom", id: "model", name: "Model" }],
    routeVariants: [],
  }));
  const config = {
    models: {
      providers: {
        custom: {
          baseUrl: "https://retention.invalid/v1",
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
  const { resolvePreparedModelRuntimeOwnerBySnapshot } =
    await import("./prepared-model-runtime.owner.js");
  const inventories: WeakRef<object>[] = [];
  const generations = 6;
  for (let generation = 0; generation < generations; generation++) {
    const reloaded = { ...config, logging: { level: generation % 2 ? "debug" : "info" } } as const;
    await refreshPreparedModelRuntimeSnapshots(reloaded, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const snapshot = await prepareModelRuntimeSnapshot(fixture.agentInput("default", reloaded));
    await snapshot.loadFullModelCatalog?.({ refresh: true });
    const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)?.catalogInventory;
    expect(inventory?.providers.has("custom")).toBe(true);
    inventories.push(new WeakRef(inventory!));
    // Mock call records would otherwise retain every generation's catalog owner.
    vi.clearAllMocks();
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await setImmediate();
    // queryObjects performs a full collection without V8-only flag mutation.
    queryObjects(WeakRef);
    if (inventories.slice(0, -1).every((inventory) => inventory.deref() === undefined)) {
      break;
    }
  }
  // Each refresh seeds from its predecessor; only the published generation may remain.
  expect(inventories.map((inventory) => inventory.deref() !== undefined)).toEqual([
    ...Array.from({ length: generations - 1 }, () => false),
    true,
  ]);
});

it("releases the reload caller while a superseded acquisition signal remains retained", async () => {
  class ReloadCaller {
    readonly fixtureLabel = "ReloadCaller";
  }
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" });
  const { signal } = mocks.prepareStaticCatalog.mock.lastCall![0] as Parameters<
    typeof prepareImplicitProviderStaticCatalog
  >[0];
  expect(signal).toBeDefined();
  function commitReload() {
    const caller = new ReloadCaller();
    const commit = () => {
      markPreparedModelRuntimeSnapshotsStale("retention fixture superseded");
      return caller;
    };
    commit();
  }
  commitReload();
  vi.clearAllMocks();
  await setImmediate();
  expect(queryObjects(ReloadCaller)).toBe(0);
  expect(signal!.aborted).toBe(true);
  expect(signal!.reason).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
});
