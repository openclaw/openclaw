// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { describe } from "vitest";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withinTest } from "../../test/helpers/promise.js";
import { bindPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import { getProcessPluginCache } from "../plugins/plugin-cache.js";
import { retirePluginCache } from "../plugins/plugin-cache.js";
import { withPluginCache } from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { expectCollected, forceFullGc } from "../test-utils/retention.js";
import { retireAgentDeleteRuntime } from "./agent-delete-databases.js";
import { withAgentDeletion } from "./agent-lifecycle-registry.js";
import type { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { getPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { loadPublishedGatewayReplyDispatchRuntime } from "./prepared-model-runtime.js";
import { publishPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { prepareModelRuntimeSnapshot as prepare } from "./prepared-model-runtime.js";
import { refreshPreparedModelRuntimeSnapshots as refresh } from "./prepared-model-runtime.js";
import { retirePreparedModelRuntimeAgent } from "./prepared-model-runtime.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

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
  function holdCatalogWrite() {
    const started = createDeferred();
    const result = createDeferred<Record<string, never>>();
    const pending: Promise<unknown>[] = [];
    const release = () => result.resolve({});
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      started.resolve();
      return await result.promise;
    });
    return {
      started: started.promise,
      release,
      track<T>(promise: Promise<T>) {
        pending.push(promise);
        return promise;
      },
      async [Symbol.asyncDispose]() {
        release();
        await Promise.allSettled(pending);
      },
    };
  }
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
