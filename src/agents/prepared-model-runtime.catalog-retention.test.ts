// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { expectCollected, forceFullGc } from "../test-utils/retention.js";
import type { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
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
    forceFullGc();
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

it("keeps retained catalog auth facts without retaining a superseded build snapshot", async () => {
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
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const retained = await (async () => {
    const snapshot = await prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
    const catalog = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(getPreparedModelFullCatalogAuth(catalog)).toBeDefined();
    return { catalog, snapshot: new WeakRef(snapshot) };
  })();
  await refreshPreparedModelRuntimeSnapshots(
    { ...config, logging: { level: "debug" } },
    { gatewayLifecycle: true, catalogMode: "static" },
  );
  vi.clearAllMocks();
  await expectCollected(retained.snapshot);
  expect(retained.catalog.entries).toEqual([
    expect.objectContaining({ provider: "custom", id: "model" }),
  ]);
  expect(getPreparedModelFullCatalogAuth(retained.catalog)).toBeDefined();
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
    return new WeakRef(caller);
  }
  const caller = commitReload();
  vi.clearAllMocks();
  await expectCollected(caller);
  expect(signal!.aborted).toBe(true);
  expect(signal!.reason).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
});

it("releases closed borrowed snapshots while native async contexts remain retained", () => {
  const output = execNodeEvalSync(
    `import assert from "node:assert/strict";
     import { AsyncLocalStorage } from "node:async_hooks";
     import { expectCollected } from ${JSON.stringify(new URL("../test-utils/retention.ts", import.meta.url).href)};
     import { scopePreparedModelRuntimeLease, getPreparedModelRuntimeBorrowedSnapshot } from ${JSON.stringify(new URL("./prepared-model-runtime-generation-scope.ts", import.meta.url).href)};
     class Snapshot {}
     const generation = { remoteCatalog: null };
     const retained = await (async () => {
       const snapshot = new Snapshot();
       const lease = scopePreparedModelRuntimeLease({
         snapshot, pluginGeneration: generation, run: run => run(),
         [Symbol.asyncDispose]: async () => {},
       });
       const context = lease.run(() => AsyncLocalStorage.snapshot());
       assert.equal(context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), snapshot);
       const disposal = lease[Symbol.asyncDispose]();
       assert.equal(context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), undefined);
       assert.throws(() => lease.run(() => {}), /lease is closed/);
       await disposal;
       return { context, snapshot: new WeakRef(snapshot) };
     })();
     await expectCollected(retained.snapshot);
     assert.equal(retained.context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), undefined);
     console.log("Closed borrowed snapshot released");`,
    { imports: ["./scripts/tsx.mjs"], execArgv: ["--expose-gc"], timeout: 10_000 },
  );
  expect(output.trim()).toBe("Closed borrowed snapshot released");
});
