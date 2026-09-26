// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  retirePluginCache,
} from "../plugins/plugin-cache.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { PreparedModelRuntimeAuthPublicationOwner } from "./prepared-model-runtime-auth-publication.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
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

async function publishOwner(agentIds = ["default"]) {
  mocks.configuredAgentIds = agentIds;
  const config = {};
  const registry = createEmptyPluginRegistry();
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const input = fixture.agentInput("default", config);
  const snapshot = await prepareModelRuntimeSnapshot(input);
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

async function listModels(config: OpenClawConfig) {
  const getConfig = () => config;
  const loader = () => loadGatewayModelCatalogSnapshot({ getConfig });
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: (params) => loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig }),
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig }),
  });
  const respond = vi.fn();
  const handler = modelsHandlers["models.list"]!;
  await handler({
    req: { type: "req", id: "auth-recovery", method: "models.list" },
    params: { agentId: "default" },
    client: null,
    isWebchatConnect: () => false,
    context: {
      ...createGatewayRequestContext(
        makeContextParams({ loadGatewayModelCatalogSnapshot: loader }),
      ),
      getRuntimeConfig: getConfig,
    },
    respond,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ models: [] }), undefined);
}

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
    ["plugin retirement", () => new PluginInstanceUnavailableError("synthetic")],
    ["generation lifetime retirement", retiredGenerationFailure],
    [
      "publication supersession",
      () => new PreparedModelRuntimePublicationSupersededError("retired"),
    ],
  ] as const)("republishes after %s without another trigger", async (_name, failure) => {
    const { config, input, snapshot, registry } = await publishOwner();
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
    const error = await failure(snapshot);
    mocks.resolveAmbientCredentials.mockImplementationOnce(() => {
      throw error;
    });
    try {
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: snapshot.metadataSnapshot, pluginRegistry: registry },
        () => mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false }),
      );
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toBeDefined();
      const replacement = await prepareModelRuntimeSnapshot(input);
      expect(replacement.pluginRegistry).toBe(currentRegistry);
      expect(replacement.isCurrent()).toBe(true);
      await listModels(config);
      expect(phases).toContain("published");
      expect(phases).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("recovers when the retirement observer clears the reused generation before failure", async () => {
    const metadataSnapshot = mocks.pluginMetadataSnapshot;
    mocks.pluginMetadataSnapshot = { ...metadataSnapshot };
    const currentCache = getPluginCache();
    const cache = createPluginCache();
    bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, cache);
    const { config, input } = await publishOwner();
    const currentRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => params.reusableRegistry ?? currentRegistry,
    );
    let retirement: Promise<unknown> | undefined;
    const publish = pluginLifetime.publishPreparedPluginGeneration;
    const publication = vi
      .spyOn(pluginLifetime, "publishPreparedPluginGeneration")
      .mockImplementationOnce((owner, generation) => {
        publish(owner, generation);
        retirement = retirePluginCache(cache);
        expect(owner.pluginGeneration).toBeUndefined();
        bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, currentCache);
        throw new PreparedModelRuntimePublicationSupersededError("plugin generation retired");
      });
    try {
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toBeDefined();
      const replacement = await prepareModelRuntimeSnapshot(input);
      expect(replacement.pluginRegistry).toBe(currentRegistry);
      expect(replacement.isCurrent()).toBe(true);
      await listModels(config);
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      publication.mockRestore();
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
    const waiting = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    void waiting.catch(() => {});
    try {
      await started.promise;
      mocks.mutationListener?.({ affectsInheritedStores: true });
      finish.resolve();
      await expect(waiting).resolves.toBeDefined();
      for (const agentId of ["default", "worker"]) {
        const published = await prepareModelRuntimeSnapshot(fixture.agentInput(agentId, config));
        expect(published.pluginRegistry).toBe(currentRegistry);
        expect(published.isCurrent()).toBe(true);
      }
      await listModels(config);
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
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      phases.push(event.phase);
      if (event.phase === "failed") {
        failed.resolve(event.error);
      }
    });
    mocks.resolveAmbientCredentials.mockClear().mockImplementation(() => {
      throw failure;
    });
    const currentRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => params.reusableRegistry ?? currentRegistry,
    );
    try {
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      const waiting = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      const rejected = expect(waiting).rejects.toThrow("after 1 fresh-generation retry");
      const recorded = await failed.promise;
      await rejected;
      expect(recorded.cause).toBe(failure);
      expect(owner.refreshError).toBe(recorded);
      expect(owner.pending).toBeUndefined();
      expect(owner.needsRefresh).toBe(true);
      await expect(prepareModelRuntimeSnapshot(input)).rejects.toBe(recorded);
      expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
      expect(phases.filter((phase) => phase === "failed")).toHaveLength(1);
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("after 1 fresh-generation retry"),
      );
    } finally {
      unregister();
    }
  });
});
