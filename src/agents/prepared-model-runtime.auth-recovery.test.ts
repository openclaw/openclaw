// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryGatewayOwner,
  markPluginRecordBorrowed,
  markPluginRegistryActive,
  isPluginRegistryRetired,
  quiescePluginRegistry,
} from "../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope, isAsyncWorkScopeActiveHere } from "../shared/async-work-scope.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { PreparedModelRuntimeAuthPublicationOwner } from "./prepared-model-runtime-auth-publication.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch,
  markPreparedModelRuntimeSnapshotsStale as markStale,
  prepareModelRuntimeSnapshot as prepare,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
  registerPreparedModelRuntimePublicationListener,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import {
  ownerKey,
  resolvePreparedModelRuntimeOwnerBySnapshot,
} from "./prepared-model-runtime.owner.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import * as pluginLifetime from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "auth-generation-recovery" });
const { mocks } = fixture;
const loadDispatch = () => loadPublishedDispatch({ agentId: "default" });

function registeredInstance(id: string) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  return { registry, record, instance: new PluginInstance(id, { record, registry }) };
}

async function publishOwner(
  agentIds = ["default"],
  registry = createEmptyPluginRegistry(),
  config: OpenClawConfig = {},
) {
  mocks.configuredAgentIds = agentIds;
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await refresh(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const input = fixture.agentInput("default", config);
  const snapshot = await prepare(input);
  return { config, input, snapshot, registry };
}

async function retiredGenerationFailure(snapshot: PreparedModelRuntimeSnapshot) {
  const generation = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!.pluginGeneration!;
  const retired = { ...generation, pluginRegistry: undefined, inboundPluginRegistry: undefined };
  await retainPreparedPluginGeneration(retired)();
  try {
    await retainPreparedPluginGeneration(retired)();
  } catch (error) {
    expect(error).toMatchObject({ message: "Prepared plugin generation has retired" });
    return error;
  }
  throw new Error("Fixture generation was not retired");
}

describe("configured plugin generation recovery", () => {
  it("retains exact thinking policy until borrowed Gateway registry replacement", async () => {
    const provider = "stale-policy-fixture";
    const entry = { provider, id: "reasoner", name: "Reasoner", reasoning: true };
    const policy = (label: string, defaultLevel: "low" | "high") => ({
      id: provider,
      label,
      auth: [],
      resolveThinkingProfile: () => ({
        levels: [{ id: "off" as const }, { id: defaultLevel }],
        defaultLevel,
      }),
    });
    const { registry, record, instance } = registeredInstance(provider);
    registry.providers.push({
      pluginId: record.id,
      source: "test",
      provider: instance.wrap(policy("Captured policy", "low")),
    });
    // An activated Gateway registry has no prepared-owned disposal lifetime.
    const gateway = createPluginRegistryOwner(registry);
    markPluginRegistryActive(registry);
    const { snapshot } = await publishOwner(
      ["default"],
      registry,
      providerConfig(provider, {
        baseUrl: "https://policy.invalid/v1",
        models: [modelDefinition(entry.id, { ...entry, contextWindow: 8_192, maxTokens: 1_024 })],
      }),
    );
    const generation = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!.pluginGeneration!;
    const release = retainPreparedPluginGeneration(generation);
    const ambient = createEmptyPluginRegistry();
    ambient.providers.push({
      pluginId: "ambient-policy",
      source: "test",
      provider: policy("Ambient policy", "high"),
    });
    const previousActive = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(ambient);
    const readThinking = () =>
      resolveEffectiveThinkingProfile({
        provider,
        context: { provider, modelId: entry.id, reasoning: true },
        catalogEntry: snapshot.modelCatalog.entries.find((row) => row.id === entry.id),
      });
    try {
      expect(readThinking()?.defaultLevel).toBe("low");
      markStale("scoped policy refresh", {
        agentIds: new Set(["default"]),
        waitForReplacement: true,
      });
      expect(snapshot.isCurrent()).toBe(false);
      expect(isPluginRegistryRetired(registry)).toBe(false);
      expect(readThinking()?.defaultLevel).toBe("low");
      // Committing the Gateway successor, not staling the catalog, closes the lender.
      gateway.publish(ambient);
      expect(isPluginRegistryRetired(registry)).toBe(true);
      expect(readThinking).toThrow(PluginInstanceUnavailableError);
      await disposePluginRegistryInstances(registry);
    } finally {
      await release();
      await gateway.close();
      restoreActivePluginRegistrySnapshot(previousActive);
    }
  });

  it.each(["admitted registry", "metadata cache"] as const)(
    "does not republish independent retirement of %s",
    async (source) => {
      const originalMetadata = mocks.pluginMetadataSnapshot;
      await using cache = createPluginCache();
      mocks.pluginMetadataSnapshot = { ...originalMetadata };
      bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, cache);
      const { registry, instance } = registeredInstance("owned-retirement");
      if (source === "admitted registry") {
        // An admitting Gateway link does not make this prepared instance its loan.
        const gatewayRegistry = createEmptyPluginRegistry();
        bindPluginRegistryGatewayOwner(registry, { current: () => gatewayRegistry });
      }
      const { input, snapshot } = await publishOwner(["default"], registry);
      mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
      const events = vi.fn();
      const unregister = registerPreparedModelRuntimePublicationListener(events);
      try {
        if (source === "metadata cache") {
          await retirePluginCache(cache);
        } else {
          quiescePluginRegistry(registry);
        }
        expect(snapshot.isCurrent()).toBe(false);
        expect(instance.acceptingCalls).toBe(false);
        await expect(prepare(input)).rejects.toThrow(
          "Prepared model runtime plugin generation retired",
        );
        expect(events).not.toHaveBeenCalled();
        expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
      } finally {
        unregister();
        mocks.pluginMetadataSnapshot = originalMetadata;
      }
    },
  );

  it.each([
    { borrowed: true, fails: false },
    { borrowed: false, fails: true },
  ])(
    "republishes retired Gateway facts once (borrowed=$borrowed, failure=$fails)",
    async ({ borrowed, fails }) => {
      const originalMetadata = mocks.pluginMetadataSnapshot;
      const currentCache = getPluginCache();
      const cache = createPluginCache();
      mocks.pluginMetadataSnapshot = { ...originalMetadata };
      bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, cache);
      const { registry: lender, record, instance } = registeredInstance("gateway-lender");
      markPluginRegistryActive(lender);
      const gateway = createPluginRegistryOwner(lender);
      const selectedRegistry = borrowed ? createEmptyPluginRegistry() : lender;
      if (borrowed) {
        selectedRegistry.plugins.push(record);
        markPluginRecordBorrowed(selectedRegistry, record);
      }
      const { config, input, snapshot, registry } = await publishOwner(
        ["default"],
        selectedRegistry,
      );
      expect(instance.owner?.registry).toBe(lender);
      const generation = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!.pluginGeneration!;
      const nextRegistry = createEmptyPluginRegistry();
      const failure = new Error("fresh registry acquisition failed");
      const closingScope = new AsyncWorkScope();
      mocks.pluginMetadataSnapshot = { ...originalMetadata };
      bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, currentCache);
      mocks.loadAgentRuntimePluginRegistryHandle.mockClear().mockImplementation(() => {
        expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
        expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
        expect(getPluginCache()).toBe(currentCache);
        expect(isAsyncWorkScopeActiveHere(closingScope)).toBe(false);
        if (fails) {
          throw failure;
        }
        return nextRegistry;
      });
      let retirement: Promise<unknown> | undefined;
      try {
        retirement = closingScope.run(() => {
          closingScope.beginClose();
          return withPluginCache(cache, () =>
            withPreparedModelRuntimePluginGenerationScope(generation, () =>
              withPluginRuntimeGenerationScope(
                { metadataSnapshot: snapshot.metadataSnapshot, pluginRegistry: registry },
                () => {
                  quiescePluginRegistry(lender);
                  return retirePluginCache(cache);
                },
              ),
            ),
          );
        });
        const currentConfig: OpenClawConfig = fails
          ? config
          : { ...config, agents: { defaults: { heartbeat: { every: "0m" } } } };
        advancePreparedModelRuntimeConfig(currentConfig);
        const dispatch = loadDispatch();
        if (fails) {
          await expect(dispatch).rejects.toBe(failure);
          await expect(prepare(input)).rejects.toBe(failure);
          expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(1);
          expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("fresh registry acquisition failed"),
          );
        } else {
          await expect(dispatch).resolves.toBeDefined();
          const replacement = await prepare(input);
          expect(replacement.pluginRegistry).toBe(nextRegistry);
          expect(replacement.isCurrent()).toBe(true);
          expect(snapshot.isCurrent()).toBe(false);
          expect(replacement.config).toEqual(currentConfig);
          expect(mocks.warn).not.toHaveBeenCalled();
        }
      } finally {
        mocks.pluginMetadataSnapshot = originalMetadata;
        await retirement;
        await closingScope.drain();
        await gateway.close();
      }
    },
  );
});

describe("auth publication generation recovery", () => {
  it("preserves the retirement reason when an auth gate settles after its owner retires", async () => {
    const { snapshot } = await publishOwner();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!;
    const publication = new PreparedModelRuntimeAuthPublicationOwner();
    publication.enqueue([owner]);
    const pending = expect(owner.pending).rejects.toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
    const retirement = new Error("Prepared plugin registry retired before auth settlement");
    await publication.drain({
      owners: new Map([[ownerKey(owner.input), owner]]),
      publish: async () => {
        owner.needsRefresh = true;
        owner.refreshError = retirement;
      },
      publishOwners: vi.fn(),
    });
    await pending;
    expect(owner.refreshError).toBe(retirement);
    expect(owner.pending).toBeUndefined();
  });

  it.each([
    ["generation lifetime retirement", retiredGenerationFailure],
    [
      "publication supersession",
      () => new PreparedModelRuntimePublicationSupersededError("retired"),
    ],
    ["retirement observer clearing the reused generation", undefined],
  ] as const)("republishes after %s without another trigger", async (_name, failure) => {
    const metadataSnapshot = mocks.pluginMetadataSnapshot;
    const currentCache = getPluginCache();
    const cache = failure ? undefined : createPluginCache();
    if (cache) {
      mocks.pluginMetadataSnapshot = { ...metadataSnapshot };
      bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, cache);
    }
    const { input, snapshot, registry } = await publishOwner();
    const currentRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      if (params.reusableRegistry) {
        return params.reusableRegistry;
      }
      expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
      return currentRegistry;
    });
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      phases.push(phase),
    );
    let retirement: Promise<unknown> | undefined;
    const publishGeneration = pluginLifetime.publishPreparedPluginGeneration;
    const publication = cache
      ? vi
          .spyOn(pluginLifetime, "publishPreparedPluginGeneration")
          .mockImplementationOnce((owner, generation) => {
            publishGeneration(owner, generation);
            retirement = retirePluginCache(cache);
            expect(owner.pluginGeneration).toBeUndefined();
            bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, currentCache);
            throw new PreparedModelRuntimePublicationSupersededError("plugin generation retired");
          })
      : undefined;
    try {
      const mutate = () =>
        mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      if (failure) {
        const error = await failure(snapshot);
        mocks.resolveAmbientCredentials.mockImplementationOnce(() => {
          throw error;
        });
        withPluginRuntimeGenerationScope(
          { metadataSnapshot: snapshot.metadataSnapshot, pluginRegistry: registry },
          mutate,
        );
      } else {
        mutate();
      }
      await expect(loadDispatch()).resolves.toBeDefined();
      const replacement = await prepare(input);
      expect(replacement.pluginRegistry).toBe(currentRegistry);
      expect(replacement.isCurrent()).toBe(true);
      expect(phases).toContain("published");
      expect(phases).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      unregister();
      publication?.mockRestore();
      mocks.pluginMetadataSnapshot = metadataSnapshot;
      await retirement;
    }
  });

  it("refreshes owners merged into an already queued recovery component", async () => {
    const { config, registry } = await publishOwner(["default", "worker"]);
    const currentRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => params.reusableRegistry ?? currentRegistry,
    );
    const started = createDeferred();
    const finish = createDeferred();
    let first = true;
    mocks.resolveAmbientCredentials.mockImplementation(async () => {
      if (first) {
        first = false;
        started.resolve();
        await finish.promise;
        throw new PluginInstanceUnavailableError("synthetic");
      }
      if (getPluginRuntimeGenerationRegistry() === registry) {
        throw new PluginInstanceUnavailableError("synthetic");
      }
      return {};
    });
    mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    const waiting = loadPublishedDispatch({ agentId: "worker" });
    void waiting.catch(() => {});
    try {
      await started.promise;
      mocks.mutationListener?.({ affectsInheritedStores: true });
      finish.resolve();
      await expect(waiting).resolves.toBeDefined();
      for (const agentId of ["default", "worker"]) {
        const published = await prepare(fixture.agentInput(agentId, config));
        expect(published.pluginRegistry).toBe(currentRegistry);
        expect(published.isCurrent()).toBe(true);
      }
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await waiting.catch(() => {});
    }
  });

  it("records one failed fresh-generation retry and settles readers", async () => {
    const { input, snapshot } = await publishOwner();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!;
    const failure = new PluginInstanceUnavailableError("synthetic");
    const failed = createDeferred<Error>();
    const phases: string[] = [];
    using _ = {
      [Symbol.dispose]: registerPreparedModelRuntimePublicationListener((event) => {
        phases.push(event.phase);
        if (event.phase === "failed") {
          failed.resolve(event.error);
        }
      }),
    };
    mocks.resolveAmbientCredentials.mockClear().mockImplementation(() => {
      throw failure;
    });
    const currentRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => params.reusableRegistry ?? currentRegistry,
    );
    mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    const waiting = loadDispatch();
    const rejected = expect(waiting).rejects.toThrow("after 1 fresh-generation retry");
    const recorded = await failed.promise;
    await rejected;
    expect(recorded.cause).toBe(failure);
    expect(owner.refreshError).toBe(recorded);
    expect(owner).toMatchObject({ pending: undefined, needsRefresh: true });
    await expect(prepare(input)).rejects.toBe(recorded);
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
    expect(phases.filter((phase) => phase === "failed")).toHaveLength(1);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("after 1 fresh-generation retry"),
    );
  });

  it.for([false, true])(
    "joins a publication superseding the fresh auth retry (fails: %s)",
    async (fails, { signal }) => {
      const { snapshot, config } = await publishOwner();
      const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!;
      const retry = createEnteredGate();
      const nextPublication = createEnteredGate();
      const failure = new Error("successor credential acquisition failed");
      mocks.resolveAmbientCredentials
        .mockClear()
        .mockImplementationOnce(() => {
          throw new PluginInstanceUnavailableError("synthetic retired generation");
        })
        .mockImplementationOnce(async () => {
          await retry.wait();
          return {};
        })
        .mockImplementationOnce(async () => {
          await nextPublication.wait();
          if (fails) {
            throw failure;
          }
          return {};
        });
      mocks.mutationListener?.({ agentDir: owner.input.agentDir, affectsInheritedStores: false });
      const reader = prepare(owner.input);
      const dispatch = loadDispatch();
      void reader.catch(() => {});
      void dispatch.catch(() => {});
      let successor: ReturnType<typeof publish> | undefined;
      try {
        await withinTest(retry.entered, signal);
        successor = publish(owner.input, {
          force: true,
          provenance: "configured",
          catalogMode: "static",
        });
        void successor.catch(() => {});
        retry.release();
        await withinTest(nextPublication.entered, signal);
        nextPublication.release();
        if (fails) {
          await expect(successor).rejects.toBe(failure);
          await expect(reader).rejects.toThrow(failure.message);
          await expect(dispatch).rejects.toThrow(failure.message);
        } else {
          const latest = await successor;
          await expect(reader).resolves.toBe(latest);
          await expect(dispatch).resolves.toMatchObject({ agentId: "default", config });
          expect(latest.isCurrent()).toBe(true);
          expect(mocks.warn).not.toHaveBeenCalled();
        }
        expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(3);
      } finally {
        retry.release();
        nextPublication.release();
        await Promise.allSettled([reader, dispatch, successor]);
      }
    },
  );
});

describe("prepared model auth publication", () => {
  it("retains the prepared owner on bookkeeping and refreshes on auth availability changes", async () => {
    const snapshots = await vi.importActual<typeof import("./auth-profiles/runtime-snapshots.js")>(
      "./auth-profiles/runtime-snapshots.js",
    );
    const agentDir = fixture.state.agentDir("usage-publication");
    const input = { config: {}, agentDir };
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { "test:primary": { type: "token", provider: "test", token: "synthetic-token" } },
    };
    prepareSharedAuthStoreOwnershipForNative(fixture.state.env);
    snapshots.setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const initial = await publish(input);
    const events = vi.fn();
    const unregisterEvents = registerPreparedModelRuntimePublicationListener(events);
    const unregisterAuth = snapshots.registerRuntimeAuthProfileStoreMutationListener((event) => {
      mocks.mutationListener?.(event);
    });
    try {
      for (const availabilityChanged of [false, true]) {
        snapshots.updateRuntimeAuthProfileStoreSnapshot(
          {
            ...store,
            ...(!availabilityChanged ? { runtimeInheritsMainState: true } : {}),
            usageStats: {
              "test:primary": availabilityChanged
                ? { cooldownUntil: Date.now() + 60_000 }
                : { lastUsed: 2, errorCount: 1, failureCounts: { timeout: 1 } },
            },
          },
          agentDir,
        );
        expect((await prepare(input)) === initial).toBe(!availabilityChanged);
        if (availabilityChanged) {
          expect(events).toHaveBeenCalledWith({ phase: "invalidated" });
        } else {
          expect(events).not.toHaveBeenCalled();
        }
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(availabilityChanged ? 2 : 1);
      }
    } finally {
      unregisterAuth();
      unregisterEvents();
      snapshots.clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
    }
  });
});
