// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { collectForRetentionCheck, expectCollected, forceFullGc } from "../test-utils/retention.js";
import type { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import * as discoveryRetry from "./prepared-model-runtime.discovery-retry.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  getPreparedModelRuntimeSnapshot,
  retirePreparedModelRuntimeAgent,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime-retention" });
const { mocks } = fixture;

async function publishSettledCatalogBatch(
  config: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[0],
) {
  const pending: Promise<unknown>[] = [];
  let settlements: PromiseSettledResult<unknown>[] = [];
  const original = discoveryRetry.waitForDiscovery;
  const observe = vi.spyOn(discoveryRetry, "waitForDiscovery").mockImplementation((...args) => {
    const result = original(...args);
    pending.push(args[0], result);
    return result;
  });
  try {
    const batchSizes: number[] = [];
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      onBuildStats: ({ agentCount }) => batchSizes.push(agentCount),
    });
    expect(batchSizes).toEqual([2]);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(4);
    // Join only startup's existing discovery and foreground observers. Their deadline
    // callbacks legitimately retain owners until settlement, independent of batch custody.
    settlements = await Promise.allSettled(pending);
    expect(settlements.map(({ status }) => status)).toEqual(Array(4).fill("fulfilled"));
    expect(observe).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(4);
  } finally {
    pending.length = 0;
    settlements.length = 0;
    observe.mockRestore();
  }
}

function capturePublishedOwner(input: Parameters<typeof getPreparedModelRuntimeSnapshot>[0]) {
  const snapshot = getPreparedModelRuntimeSnapshot(input);
  const owner = snapshot && resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  if (!snapshot || !owner) {
    throw new Error("Expected a published owner for the retention fixture");
  }
  // Keep retired objects out of the async test frame while retaining their live sibling.
  return { owner: new WeakRef(owner), snapshot: new WeakRef(snapshot) };
}

it("releases a retired settled batch sibling while the surviving catalog and auth stay usable", async () => {
  mocks.configuredAgentIds = ["survivor", "retiring"];
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
  await publishSettledCatalogBatch(config);
  const survivorInput = fixture.agentInput("survivor", config);
  const retiringInput = fixture.agentInput("retiring", config);
  const survivor = getPreparedModelRuntimeSnapshot(survivorInput)!;
  expect(survivor.isCurrent()).toBe(true);
  const retired = capturePublishedOwner(retiringInput);
  const unowned = new WeakRef({});

  await retirePreparedModelRuntimeAgent({
    agentId: retiringInput.agentId,
    agentDirs: [retiringInput.agentDir],
  });
  expect(getPreparedModelRuntimeSnapshot(retiringInput)).toBeUndefined();
  // The worker factory's mock arguments otherwise retain both batch generations.
  vi.clearAllMocks();
  await collectForRetentionCheck("retired batch sibling");
  const retained = {
    owner: retired.owner.deref() !== undefined,
    snapshot: retired.snapshot.deref() !== undefined,
  };

  expect(unowned.deref()).toBeUndefined();
  expect(getPreparedModelRuntimeSnapshot(survivorInput)).toBe(survivor);
  expect(survivor.isCurrent()).toBe(true);
  const catalog = await survivor.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(catalog.entries).toContainEqual(
    expect.objectContaining({ provider: "custom", id: "model", name: "Model" }),
  );
  await expect(
    loadPreparedModelRuntimeAuth(survivor, { providerIds: ["custom"] }),
  ).resolves.toMatchObject({ authStore: { version: 1 } });
  expect(retained).toEqual({ owner: false, snapshot: false });
});

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
