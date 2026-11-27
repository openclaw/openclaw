// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  getProcessPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { collectForRetentionCheck, expectCollected, forceFullGc } from "../test-utils/retention.js";
import { retireAgentDeleteRuntime } from "./agent-delete-databases.js";
import { withAgentDeletion } from "./agent-lifecycle-registry.js";
import type { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  getPreparedModelFullCatalogAuth,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import * as discoveryRetry from "./prepared-model-runtime.discovery-retry.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  publishPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot as prepare,
  refreshPreparedModelRuntimeSnapshots as refresh,
  retirePreparedModelRuntimeAgent,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime-retention" });
const { mocks, holdCatalogWrite } = fixture;

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

describe("retired owner publication", () => {
  it("retires only the deleted agent's physical owners", async () => {
    mocks.configuredAgentIds = ["worker"];
    mocks.configuredAgentDirs.set("worker", fixture.state.agentDir("isolated-worker"));
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const separate = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    const input = { config: {}, agentId: "worker", agentDir: fixture.state.agentDir("worker") };
    const deleted = await publishPreparedModelRuntimeSnapshot(input);
    const sharing = await publishPreparedModelRuntimeSnapshot({ ...input, agentId: "survivor" });

    const options = { env: fixture.state.env };
    await withAgentDeletion(
      input.agentId,
      async (begin) => {
        const deletion = await begin({
          agentId: input.agentId,
          agentDir: input.agentDir,
          workspaceDir: fixture.state.workspaceDir,
          sessionsDir: fixture.state.sessionsDir(input.agentId),
          deleteFiles: false,
        });
        await deletion.assertCurrentAsync();
        const replaceJournal = openOpenClawStateDatabase(options).db.prepare(
          "UPDATE agent_deletion_journal SET operation_id = ? WHERE agent_id = ?",
        );
        replaceJournal.run("replacement", input.agentId);
        await expect(retireAgentDeleteRuntime(deletion, [input.agentDir])).rejects.toThrow(
          "no longer owns",
        );
        expect([deleted.isCurrent(), sharing.isCurrent()]).toEqual([true, true]);

        replaceJournal.run(deletion.entry.operationId, input.agentId);
        await deletion.rollback();
        await expect(retireAgentDeleteRuntime(deletion, [input.agentDir])).rejects.toThrow(
          "no longer owns",
        );
        expect([deleted.isCurrent(), sharing.isCurrent()]).toEqual([true, true]);
      },
      options,
    );

    await retirePreparedModelRuntimeAgent({ agentId: input.agentId, agentDirs: [input.agentDir] });

    expect([deleted.isCurrent(), sharing.isCurrent()]).toEqual([false, true]);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).resolves.toBe(
      separate,
    );
  });
  it("keeps a retired agent withdrawn when its in-flight configured build finishes", async ({
    signal,
  }) => {
    mocks.configuredAgentIds = ["carlos", "hal"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const firstInput = fixture.agentInput("carlos", config);
    const siblingInput = fixture.agentInput("hal", config);
    const sibling = getPreparedModelRuntimeSnapshot(siblingInput);
    expect(sibling).toBeDefined();
    await using work = holdCatalogWrite();
    const refreshing = work.track(
      refreshPreparedModelRuntimeSnapshots(config, { agentIds: new Set(["carlos"]) }),
    );
    await withinTest(work.started, signal);
    const retiring = work.track(
      retirePreparedModelRuntimeAgent({ agentId: "carlos", agentDirs: [firstInput.agentDir] }),
    );
    work.release();
    await withinTest(Promise.all([refreshing, retiring]), signal);
    expect(getPreparedModelRuntimeSnapshot(firstInput)).toBeUndefined();
    expect(getPreparedModelRuntimeSnapshot(siblingInput)).toBe(sibling);
  });
  it("keeps logged-out reply dispatch after the config operation cache retires", async ({
    signal,
  }) => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const nextConfig = { messages: { responsePrefix: "updated" } };
    const metadata = { ...(await pluginMetadata.resolvePluginMetadataSnapshotAsync({ config })) };
    bindPluginMetadataSnapshotCache(metadata, getProcessPluginCache());
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      pluginMetadataSnapshot: metadata,
    });
    const input = fixture.agentInput("default", nextConfig);
    const operationCache = createPluginCache();
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
      .mockImplementation(async () => {
        const snapshot = { ...metadata };
        bindPluginMetadataSnapshotCache(snapshot, getPluginCache());
        return snapshot;
      });
    await using write = holdCatalogWrite();
    const resources = new AsyncDisposableStack();
    let replacement: ReturnType<typeof refresh> | undefined;
    let reader: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let snapshotRead: ReturnType<typeof prepare> | undefined;
    let retirement: ReturnType<typeof retirePluginCache> | undefined;
    try {
      replacement = withPluginCache(operationCache, () =>
        refreshPreparedModelRuntimeSnapshots(nextConfig, {
          gatewayLifecycle: true,
          pluginMetadataSnapshot: metadata,
        }),
      );
      void replacement.catch(() => undefined);
      await withinTest(write.started, signal);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.mutationListener?.({
        agentDir: input.agentDir,
        affectsInheritedStores: false,
        profileSetChanged: true,
      });
      write.release();
      await withinTest(replacement, signal);
      retirement = retirePluginCache(operationCache);
      await withinTest(retirement, signal);

      reader = loadPublishedGatewayReplyDispatchRuntime({
        agentId: "default",
        onRuntimeLease: (lease) => {
          resources.use(lease);
        },
      });
      await expect(withinTest(reader, signal)).resolves.toMatchObject({ config: nextConfig });
      snapshotRead = prepareModelRuntimeSnapshot(input);
      const snapshot = await withinTest(snapshotRead, signal);
      expect(snapshot.isCurrent()).toBe(true);
      expect(snapshot.createStores().authStorage.getAll()).toEqual({});
    } finally {
      write.release();
      await resources.disposeAsync();
      const closing = closePreparedModelRuntimeSnapshots();
      await Promise.allSettled([replacement, reader, snapshotRead, retirement, closing]);
      resolveMetadata.mockRestore();
      await retirePluginCache(operationCache);
    }
  });
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
    const catalog = await snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
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

it("releases closed borrowed snapshots while native async contexts remain retained", () => {
  const output = execNodeEvalSync(
    `import assert from "node:assert/strict";
     import { AsyncLocalStorage } from "node:async_hooks";
     import { expectCollected } from ${JSON.stringify(new URL("../test-utils/retention.ts", import.meta.url).href)};
     import { scopePreparedModelRuntimeLease, getPreparedModelRuntimeBorrowedSnapshot } from ${JSON.stringify(new URL("./prepared-model-runtime-generation-scope.ts", import.meta.url).href)};
     class Snapshot {}
     const generation = { remoteCatalog: null };
     const otherGeneration = { remoteCatalog: null };
     const live = scopePreparedModelRuntimeLease({
       snapshot: new Snapshot(), pluginGeneration: otherGeneration, run: run => run(),
       [Symbol.asyncDispose]: async () => {},
     });
     const liveContext = live.run(() => AsyncLocalStorage.snapshot());
     const { promise: pending, resolve: finish } = Promise.withResolvers();
     const retained = (() => {
       const snapshot = new Snapshot();
       const lease = scopePreparedModelRuntimeLease({
         snapshot, pluginGeneration: generation, run: run => run(),
         [Symbol.asyncDispose]: () => pending,
       });
       const context = lease.run(() => AsyncLocalStorage.snapshot());
       assert.equal(context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), snapshot);
       assert.equal(context(() => getPreparedModelRuntimeBorrowedSnapshot(otherGeneration)), undefined);
       const disposal = lease[Symbol.asyncDispose]();
       assert.equal(context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), undefined);
       assert.throws(() => lease.run(() => {}), /lease is closed/);
       assert.equal(lease[Symbol.asyncDispose](), disposal);
       return { context, snapshot: new WeakRef(snapshot), disposal };
     })();
     // The retired disposer is still pending while the independent sibling is usable.
     await expectCollected(retained.snapshot);
     assert.equal(liveContext(() => getPreparedModelRuntimeBorrowedSnapshot(otherGeneration)), live.snapshot);
     finish();
     await retained.disposal;
     await live[Symbol.asyncDispose]();
     assert.equal(liveContext(() => getPreparedModelRuntimeBorrowedSnapshot(otherGeneration)), undefined);
     assert.equal(retained.context(() => getPreparedModelRuntimeBorrowedSnapshot(generation)), undefined);
     console.log("Closed borrowed snapshot released");`,
    { imports: ["./scripts/tsx.mjs"], execArgv: ["--expose-gc"], timeout: 10_000 },
  );
  expect(output.trim()).toBe("Closed borrowed snapshot released");
});
