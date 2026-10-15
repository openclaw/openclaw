// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime-retention" });
const { mocks } = fixture;

function exposeGc(): () => void {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
}

it("releases superseded catalog inventories across neutral reloads", async () => {
  const gc = exposeGc();
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
  const released = new Set<number>();
  const releases = new FinalizationRegistry<number>((generation) => released.add(generation));
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
    releases.register(inventory!, generation);
    // Mock call records would otherwise retain every generation's catalog owner.
    vi.clearAllMocks();
  }
  for (let attempt = 0; attempt < 20 && released.size < generations - 1; attempt++) {
    gc();
    await setImmediate();
  }
  // Each refresh seeds from its predecessor; only the published generation may remain.
  expect([...released].toSorted((left, right) => left - right)).toEqual(
    Array.from({ length: generations - 1 }, (_, generation) => generation),
  );
});
