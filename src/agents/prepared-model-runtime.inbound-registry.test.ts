// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { registryContainsRuntimePluginIds } from "../plugins/active-runtime-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { DiscoverAuthStorageOptions } from "./agent-auth-discovery.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

async function useDiscoveryCredentials() {
  const { prepareAmbientAgentCredentialsForDiscovery } = await vi.importActual<
    typeof import("./agent-auth-discovery.js")
  >("./agent-auth-discovery.js");
  mocks.resolveAmbientCredentials.mockImplementation((options) =>
    prepareAmbientAgentCredentialsForDiscovery(
      options as Parameters<typeof prepareAmbientAgentCredentialsForDiscovery>[0],
    ),
  );
  mocks.discoverAuthStorage.mockImplementation((_dir, options) => ({
    getAll: () => (options as DiscoverAuthStorageOptions).ambientCredentials,
    getOAuthProviders: () => [],
  }));
}

describe("prepared reply dispatch runtime", () => {
  it("holds inspected input through accepted preparation and refuses a retired result", async () => {
    const database = new DatabaseSync(fixture.state.path("prepared-registration.sqlite"));
    database.exec(
      "CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)",
    );
    const registry = createEmptyPluginRegistry();
    const resources = new PluginRegistryInspectionResources(async () => {});
    resources.attach(registry);
    let disposalCount = 0;
    resources.runRegistration("prepared-native", () => {
      resources.register("prepared-native", {
        id: "sqlite",
        dispose: () => {
          disposalCount += 1;
          database.close();
        },
      });
    });
    const entered = createDeferred();
    const finish = createDeferred();
    let observedValue: unknown;
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      observedValue = database.prepare("SELECT value FROM observations").get()?.value;
      return { entries: [] };
    });
    const config = {};
    const metadata = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const preparation = prepareWorkspaceBuildGroup(
      [
        {
          config,
          agentDir: fixture.state.agentDir("default"),
          workspaceDir: fixture.state.workspaceDir,
          env: fixture.state.env,
          skipCredentials: true,
        },
      ],
      "static",
      {},
      () => registry,
      undefined,
      metadata,
    );
    const outcome = preparation.catch((error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error("Preparation completed before its static catalog dependency");
        }),
      ]);
      await resources.release();
      expect(database.isOpen).toBe(true);
      expect(disposalCount).toBe(0);
      finish.resolve();
      expect(await outcome).toEqual(new Error("Plugin inspection resources have been released"));
      expect(observedValue).toBe(42);
      expect(database.isOpen).toBe(false);
      expect(disposalCount).toBe(1);
    } finally {
      finish.resolve();
      await Promise.allSettled([outcome, resources.release()]);
      if (database.isOpen) {
        database.close();
      }
    }
  });

  it("carries newly selected provider auth into a derived generation and its refresh", async () => {
    await useDiscoveryCredentials();
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "initial/model" } } };
    const selectedRegistry = createEmptyPluginRegistry();
    selectedRegistry.providers.push({
      pluginId: "selected-provider",
      source: "test",
      provider: {
        id: "selected",
        label: "Selected provider",
        auth: [],
        resolveSyntheticAuth: () => ({
          apiKey: "synthetic-provider-fixture",
          source: "fixture",
          mode: "api-key",
        }),
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      params.selections?.some(
        (selection: { provider: string }) => selection.provider === "selected",
      )
        ? selectedRegistry
        : (params.reusableRegistry ?? createEmptyPluginRegistry()),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const input = {
      config,
      agentId: "default",
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
      runtimePluginSelections: [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
    };
    const lease = await acquireAgentRunPreparedModelRuntime(input, {
      catalogMode: "static",
      pluginGeneration: published.pluginGeneration,
    });
    expect(lease.snapshot.pluginRegistry === selectedRegistry).toBe(true);
    expect(lease.snapshot.authModes.selected).toBe("api_key");
    expect(published.pluginGeneration.preparedStaticProviderCatalog?.providers).toBeUndefined();
    await lease[Symbol.asyncDispose]();
    const publishedRefresh = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedRefresh.resolve();
      }
    });
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await publishedRefresh.promise;
    unregister();
    expect(getPreparedModelRuntimeSnapshot(input)?.authModes.selected).toBe("api_key");
  });

  it("isolates selected run owners while retaining the published generation and lease lifetime", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "custom/model" } } };
    const registries = new Map(
      ["first-harness", "second-harness"].map((runtime) => {
        const registry = createEmptyPluginRegistry();
        registry.agentHarnesses.push({
          pluginId: runtime,
          source: "test",
          harness: {
            id: runtime,
            label: runtime,
            supports: () => ({ supported: true }),
            runAttempt: async () => {
              throw new Error("unused");
            },
          },
        });
        return [runtime, registry] as const;
      }),
    );
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => registries.get(params.selections?.[0]?.runtime) ?? createEmptyPluginRegistry(),
    );
    const manifests: PluginManifestRecord[] = [...registries.keys()].map((id) => ({
      id,
      name: id,
      origin: "bundled",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}/index.js`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
      activation: { onStartup: false, onAgentHarnesses: [id] },
    }));
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      pluginMetadataSnapshot: createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: manifests, diagnostics: [] },
      }),
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const input = (runtime: string) => ({
      config,
      agentId: "default",
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
      allowGatewaySubagentBinding: true,
      runtimePluginSelections: [{ provider: "custom", modelId: "model", runtime }],
    });
    const options = {
      catalogMode: "static" as const,
      pluginGeneration: published.pluginGeneration,
    };
    const leases = await Promise.all(
      [...registries.keys()].map((runtime) =>
        acquireAgentRunPreparedModelRuntime(input(runtime), options),
      ),
    );
    for (const [index, runtime] of [...registries.keys()].entries()) {
      const lease = leases[index]!;
      expect(lease.snapshot.pluginRegistry === registries.get(runtime)).toBe(true);
      expect(lease.snapshot.metadataSnapshot).toBe(
        published.pluginGeneration.pluginMetadataSnapshot,
      );
      expect(lease.pluginGeneration.inboundPluginRegistry).toBe(published.inboundPluginRegistry);
      expect(Object.isFrozen(lease.pluginGeneration)).toBe(true);
      const repeated = await acquireAgentRunPreparedModelRuntime(input(runtime), options);
      expect(repeated.snapshot === lease.snapshot).toBe(true);
      expect(repeated.pluginGeneration === lease.pluginGeneration).toBe(true);
      await repeated[Symbol.asyncDispose]();
      let active = true;
      await withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        async () => {
          const nested = await acquireAgentRunPreparedModelRuntime(input(runtime), {
            pluginGeneration: lease.pluginGeneration,
          });
          expect(nested.snapshot === lease.snapshot).toBe(true);
          await nested[Symbol.asyncDispose]();
          const otherRuntime = [...registries.keys()].find((candidate) => candidate !== runtime)!;
          await expect(
            acquireAgentRunPreparedModelRuntime(input(otherRuntime), {
              pluginGeneration: lease.pluginGeneration,
            }),
          ).rejects.toThrow("plugin generation was superseded");
          active = false;
          await lease[Symbol.asyncDispose]();
          await expect(
            acquireAgentRunPreparedModelRuntime(input(runtime), {
              pluginGeneration: lease.pluginGeneration,
            }),
          ).rejects.toThrow("plugin generation was superseded");
        },
        () => (active ? lease.snapshot : undefined),
      );
    }
    expect(
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })) === published,
    ).toBe(true);
    expect(published.pluginGeneration.pluginRegistry?.agentHarnesses).toEqual([]);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4);
  });

  it.each(["disabled", "error", "not-imported"] as const)(
    "preserves a selected provider's %s outcome when borrowing its parent lease",
    async (outcome) => {
      mocks.configuredAgentIds = ["default"];
      const config = {
        agents: { defaults: { model: "custom/model" } },
        plugins: {
          // A shared-capability fallback cannot excuse a missing selected model owner.
          slots: {
            memory: "none",
            ...(outcome === "not-imported" ? { contextEngine: "qwen" } : {}),
          },
          entries: { qwen: { enabled: outcome !== "disabled" } },
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(
        createPluginRecord({
          id: "qwen",
          origin: "bundled",
          status: outcome === "not-imported" ? "loaded" : outcome,
          enabled: outcome !== "disabled",
          imported: false,
          error: outcome === "error" ? "provider fixture failed to load" : undefined,
        }),
      );
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
        params.selections?.some(
          (selection: { provider: string }) => selection.provider === "bailian-token-plan",
        )
          ? registry
          : createEmptyPluginRegistry(),
      );
      const metadata = createPluginMetadataSnapshot({
        config,
        manifestRegistry: makeRegistry([
          { id: "qwen", origin: "bundled", channels: [], providers: ["bailian-token-plan"] },
        ]),
      });
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: {
          ...metadata,
          owners: {
            ...metadata.owners,
            providers: new Map([["bailian-token-plan", ["qwen"]]]),
          },
        },
      });
      const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
      const input = {
        config,
        agentId: "default",
        agentDir: published.agentDir,
        workspaceDir: published.workspaceDir,
        allowGatewaySubagentBinding: true,
        runtimePluginSelections: [
          { provider: "bailian-token-plan", modelId: "qwen3.7-max", runtime: "openclaw" },
        ],
      };
      const parent = await acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "static",
        pluginGeneration: published.pluginGeneration,
      });
      expect(parent.pluginGeneration).not.toBe(published.pluginGeneration);
      let active = true;
      try {
        await withPreparedModelRuntimePluginGenerationScope(
          parent.pluginGeneration,
          async () => {
            const borrowing = acquireAgentRunPreparedModelRuntime(input, {
              catalogMode: "static",
              pluginGeneration: parent.pluginGeneration,
            });
            if (outcome === "not-imported") {
              await expect(borrowing).rejects.toThrow("plugin generation was superseded");
              return;
            }
            const nested = await borrowing;
            expect(nested.snapshot).toBe(parent.snapshot);
            expect(registryContainsRuntimePluginIds(registry, ["qwen"])).toBe(false);
            if (outcome === "error") {
              expect(nested.snapshot.pluginRegistry?.plugins[0]?.error).toBe(
                "provider fixture failed to load",
              );
            }
            await nested[Symbol.asyncDispose]();
          },
          () => (active ? parent.snapshot : undefined),
        );
      } finally {
        active = false;
        await parent[Symbol.asyncDispose]();
      }
    },
  );

  it("keeps a rejected auth refresh projection unavailable without affecting siblings", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await refreshPreparedModelRuntimeSnapshots(
      {},
      {
        gatewayLifecycle: true,
        catalogMode: "static",
      },
    );
    const defaultRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const refreshFailed = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "failed") {
        refreshFailed.resolve();
      }
    });
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new Error("auth refresh rejected");
    });

    mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    await refreshFailed.promise;
    unregister();

    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).resolves.toBe(
      defaultRuntime,
    );
  });

  it("aborts run admission without retaining an owner after auth publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const input = {
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config,
      workspaceDir: "/tmp/dynamic-workspace",
    };
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const testApi = getPreparedModelRuntimeTestApi();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    const finishAuthRefreshGate = createDeferred();
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
      finishAuthRefresh = () => finishAuthRefreshGate.resolve();
      await finishAuthRefreshGate.promise;
      return { agentDir: String(agentDir), wrote: false };
    });

    let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
    try {
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
      const abort = new AbortController();
      admission = acquireAgentRunPreparedModelRuntime(input, { abortSignal: abort.signal });
      const observed = admission.then(
        () => "resolved",
        () => "rejected",
      );
      await expect(Promise.race([observed, Promise.resolve("pending")])).resolves.toBe("pending");
      abort.abort(new Error("request cancelled"));
      await expect(admission).rejects.toMatchObject({ name: "AbortError" });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

      finishAuthRefreshGate.resolve();
      await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      const lease = await acquireAgentRunPreparedModelRuntime(input);
      expect(lease.snapshot).toMatchObject({ agentId: "default", agentDir: input.agentDir });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);
      await lease[Symbol.asyncDispose]();
    } finally {
      finishAuthRefreshGate.resolve();
      await Promise.allSettled([
        admission?.then((lease) => lease[Symbol.asyncDispose]()),
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ]);
    }
  });
});

it("refreshes successor discovery auth after the preceding runtime registry retires", async () => {
  await useDiscoveryCredentials();
  const createRuntime = (version: string) => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "catalog-owner" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    registry.providers.push({
      pluginId: record.id,
      source: record.source,
      provider: { id: "runtime-provider", label: "Runtime provider", auth: [] },
    });
    // A discovery entry may expose auth absent from the runtime registration.
    const discovery = instance.wrap<ProviderPlugin>({
      id: "discovery-auth",
      label: "Discovery auth",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: `synthetic-${version}-not-real`,
        source: "fixture",
        mode: "api-key",
      }),
    });
    return { registry, instance, discovery };
  };
  const previous = createRuntime("previous");
  const successor = createRuntime("successor");
  const added = createPluginRecord({ id: "selected-owner" });
  successor.registry.plugins.push(added);
  const addedInstance = new PluginInstance(added.id, {
    record: added,
    registry: successor.registry,
  });
  successor.registry.providers.push({
    pluginId: added.id,
    source: added.source,
    provider: { id: "selected-provider", label: "Selected provider", auth: [] },
  });
  const discoveries = new Map([
    [previous.registry, previous.discovery],
    [successor.registry, successor.discovery],
  ]);
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    const registry = getPluginRuntimeGenerationRegistry();
    const provider = registry && discoveries.get(registry);
    if (!provider) {
      throw new Error("Static discovery must run under its selected runtime registry");
    }
    return { entries: [], providers: [provider] };
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
    params.selections?.some(
      (selection: { provider: string }) => selection.provider === "selected-provider",
    )
      ? successor.registry
      : previous.registry,
  );
  const input = {
    ...fixture.agentInput("default", {}),
    runtimePluginSelections: [{ provider: "runtime-provider", modelId: "model" }],
  };
  const expandedInput = {
    ...input,
    runtimePluginSelections: [
      ...input.runtimePluginSelections,
      { provider: "selected-provider", modelId: "model" },
    ],
  };
  const metadata = createPluginMetadataSnapshot({
    config: input.config,
    manifestRegistry: makeRegistry([
      { id: "catalog-owner", providers: ["runtime-provider", "discovery-auth"], channels: [] },
      { id: "selected-owner", providers: ["selected-provider"], channels: [] },
    ]),
  });
  const first = await prepareWorkspaceBuildGroup(
    [input],
    "static",
    {},
    undefined,
    undefined,
    metadata,
  );
  const releasePrevious = retainPreparedPluginGeneration(first.pluginGeneration);
  let releaseSuccessor: (() => Promise<void>) | undefined;
  try {
    expect(first.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-previous-not-real",
    });
    const replacement = await prepareWorkspaceBuildGroup(
      [expandedInput],
      "static",
      {},
      undefined,
      first.pluginGeneration,
    );
    expect(replacement.pluginGeneration.pluginRegistry).toBe(successor.registry);
    expect(replacement.pluginGeneration.pluginRegistry).not.toBe(
      first.pluginGeneration.pluginRegistry,
    );
    releaseSuccessor = retainPreparedPluginGeneration(replacement.pluginGeneration);
    await releasePrevious();
    expect(previous.instance.lifecycle.signal.aborted).toBe(true);
    const refreshed = await prepareWorkspaceBuildGroup(
      [expandedInput],
      "static",
      {},
      undefined,
      replacement.pluginGeneration,
    );
    expect(refreshed.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-successor-not-real",
    });
  } finally {
    await releasePrevious();
    await releaseSuccessor?.();
    await addedInstance.dispose();
  }
});
