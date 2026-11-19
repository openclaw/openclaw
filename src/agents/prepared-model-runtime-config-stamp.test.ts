// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import type { AgentHarnessModelCatalogParams } from "./harness/types.js";
import { harnessRegistry } from "./model-catalog-fixtures.test-support.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import {
  getPreparedModelRuntimePolicyConfigReader,
  getPreparedModelRuntimeAuthLabels,
  getPreparedModelRuntimeAuthMaterializations,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  copyPreparedModelRuntimeSnapshotBindings,
  capturePreparedModelRuntimeCatalog,
  readCapturedPreparedModelRuntimeCatalog,
  readAdmittedPublishedModelCatalog,
  withPreparedModelRuntimePolicyConfig,
} from "./prepared-model-runtime.capture.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  acquireAgentRunPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  advancePreparedModelRuntimeConfig,
  cancelPreparedModelRuntimeRefresh,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
const prepare = (config: OpenClawConfig) =>
  prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
const dispatch = () => loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
const hotConfig = (): OpenClawConfig => ({ gateway: { reload: { mode: "hot" } } });
const publish = (
  config: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[0],
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) => refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, ...options });
async function expectPublished(config: OpenClawConfig) {
  await expect(prepare(config)).resolves.toMatchObject({ config });
  await expect(dispatch()).resolves.toMatchObject({ agentId: "default", config });
}
function expectOwner(reader: Awaited<ReturnType<typeof prepare>>, config: OpenClawConfig) {
  expect(resolvePublishedModelCatalogOwner(reader)).toMatchObject({
    agentId: "default",
    workspaceDir: "/tmp/unused-workspace",
    config,
  });
}

function holdPublication(
  resources: AsyncDisposableStack,
  config: OpenClawConfig,
  options: Parameters<typeof publish>[1] = {},
) {
  const gate = createEnteredGate();
  const pending = publish(async () => {
    await gate.wait();
    return config;
  }, options);
  resources.defer(async () => {
    gate.release();
    await Promise.allSettled([pending]);
  });
  return { started: gate.entered, release: gate.release, pending };
}

describe("prepared model runtime config stamps", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["default"];
  });

  it("retains live policy through prepublication admission, stamps, and nested read-only leases", async () => {
    const initial: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    clearRuntimeConfigSnapshot();
    try {
      // Configured admission precedes runtime publication, so current identity is no evidence.
      await refreshPreparedModelRuntimeSnapshots(initial, { gatewayLifecycle: true });
      const input = fixture.agentInput("default", initial);
      const snapshot = await prepareModelRuntimeSnapshot(input);
      const observation = snapshot.observationConfig;
      expect(getPreparedModelRuntimePolicyConfigReader(snapshot)).toBeTypeOf("function");
      expect(() => getPreparedModelRuntimePolicyConfigReader(snapshot)!()).toThrow(
        "Runtime config is not prepared",
      );
      setRuntimeConfigSnapshot(initial);
      const replacement: OpenClawConfig = { ...initial, ui: { seamColor: "#123456" } };
      advancePreparedModelRuntimeConfig(replacement);
      setRuntimeConfigSnapshot(replacement);
      const advanced = await prepareModelRuntimeSnapshot({ ...input, config: replacement });
      expect(snapshot.config).toBe(initial);
      expect(advanced.config).toBe(replacement);
      expect(advanced.observationConfig).toBe(observation);
      expect(getPreparedModelRuntimePolicyConfigReader(advanced)).toBe(
        getPreparedModelRuntimePolicyConfigReader(snapshot),
      );
      expect(getPreparedModelRuntimePolicyConfigReader(snapshot)!()).toBe(replacement);
      await using parent = await acquireReadOnlyPreparedModelRuntime({
        ...input,
        readPolicyConfig: getPreparedModelRuntimePolicyConfigReader(snapshot),
      });
      await withPreparedModelRuntimePluginGenerationScope(
        parent.pluginGeneration,
        async () => {
          await using child = await acquireReadOnlyPreparedModelRuntime({
            ...input,
            skipCredentials: true,
          });
          const revoked: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
          setRuntimeConfigSnapshot(revoked);
          expect(child.snapshot.config).toBe(initial);
          expect(getPreparedModelRuntimePolicyConfigReader(child.snapshot)).toBe(
            getPreparedModelRuntimePolicyConfigReader(snapshot),
          );
          expect(getPreparedModelRuntimePolicyConfigReader(child.snapshot)!()).toBe(revoked);
        },
        () => parent.snapshot,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not promote standalone or scoped read-only model inputs to Gateway policy", async () => {
    const scoped: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
    const live: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    setRuntimeConfigSnapshot(live);
    try {
      await refreshPreparedModelRuntimeSnapshots(scoped);
      const input = fixture.agentInput("default", scoped);
      const snapshot = await prepareModelRuntimeSnapshot(input);
      await using lease = await acquireReadOnlyPreparedModelRuntime(input);
      setRuntimeConfigSnapshot({ ...live, ui: { seamColor: "#654321" } });
      expect(getPreparedModelRuntimePolicyConfigReader(snapshot)!()).toBe(scoped);
      expect(getPreparedModelRuntimePolicyConfigReader(lease.snapshot)!()).toBe(scoped);
      expect(lease.snapshot.config).toBe(scoped);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each(["live-first", "scoped-first"] as const)(
    "keeps equal-value read-only cache hits admission-scoped: %s",
    async (order) => {
      const live: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
      const scoped = structuredClone(live);
      clearRuntimeConfigSnapshot();
      const readScoped = createRuntimeConfigReader(scoped);
      setRuntimeConfigSnapshot(live);
      const liveInput = fixture.agentInput("equal-policy", live);
      const scopedInput = { ...liveInput, config: scoped, readPolicyConfig: readScoped };
      try {
        await using first = await acquireReadOnlyPreparedModelRuntime(
          order === "live-first" ? liveInput : scopedInput,
        );
        const modelBuilds = mocks.ensureOpenClawModelsJson.mock.calls.length;
        await using second = await acquireReadOnlyPreparedModelRuntime(
          order === "live-first" ? scopedInput : liveInput,
        );
        const liveLease = order === "live-first" ? first : second;
        const scopedLease = order === "scoped-first" ? first : second;
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(modelBuilds);
        expect(second.snapshot.config).toBe(first.snapshot.config);
        expect(second.snapshot.observationConfig).toBe(first.snapshot.observationConfig);
        expect(second.snapshot).not.toHaveProperty("readPolicyConfig");
        const revoked: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
        setRuntimeConfigSnapshot(revoked);
        expect(getPreparedModelRuntimePolicyConfigReader(liveLease.snapshot)!()).toBe(revoked);
        expect(getPreparedModelRuntimePolicyConfigReader(scopedLease.snapshot)!()).toBe(scoped);
        await withPreparedModelRuntimePluginGenerationScope(
          liveLease.pluginGeneration,
          async () => {
            await using nested = await acquireReadOnlyPreparedModelRuntime(scopedInput, {
              pluginGeneration: liveLease.pluginGeneration,
            });
            expect(nested.snapshot.config).toBe(first.snapshot.config);
            expect(getPreparedModelRuntimePolicyConfigReader(nested.snapshot)!()).toBe(scoped);
          },
          () => liveLease.snapshot,
        );
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("keeps a distinct scoped reader when borrowing a value-matching parent generation", async () => {
    const initial: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    const scoped = structuredClone(initial);
    clearRuntimeConfigSnapshot();
    const readScoped = createRuntimeConfigReader(scoped);
    setRuntimeConfigSnapshot(initial);
    try {
      await refreshPreparedModelRuntimeSnapshots(initial, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const input = {
        ...fixture.agentInput("default", initial),
        workspaceDir: "/tmp/unused-workspace",
      };
      await using parent = await acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "static",
      });
      const replacement: OpenClawConfig = { ...initial, ui: { seamColor: "#123456" } };
      markPreparedModelRuntimeSnapshotsStale("deterministic generation replacement");
      await refreshPreparedModelRuntimeSnapshots(replacement, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      setRuntimeConfigSnapshot(replacement);
      await using current = await acquireAgentRunPreparedModelRuntime(
        { ...input, config: replacement },
        { catalogMode: "static" },
      );
      expect(current.pluginGeneration).not.toBe(parent.pluginGeneration);
      const modelBuilds = mocks.ensureOpenClawModelsJson.mock.calls.length;
      await withPreparedModelRuntimePluginGenerationScope(
        parent.pluginGeneration,
        async () => {
          await using child = await acquireAgentRunPreparedModelRuntime(
            { ...input, config: scoped, readPolicyConfig: readScoped },
            { catalogMode: "static", pluginGeneration: parent.pluginGeneration },
          );
          expect(child.pluginGeneration).toBe(parent.pluginGeneration);
          expect(child.snapshot.config).toBe(parent.snapshot.config);
          expect(child.snapshot.observationConfig).toBe(parent.snapshot.observationConfig);
          expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(modelBuilds);
          const revoked: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
          setRuntimeConfigSnapshot(revoked);
          expect(getPreparedModelRuntimePolicyConfigReader(parent.snapshot)!()).toBe(revoked);
          expect(getPreparedModelRuntimePolicyConfigReader(child.snapshot)!()).toBe(scoped);
        },
        () => parent.snapshot,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("preserves auth and admitted catalogs when only the policy reader changes", async () => {
    const initial: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    const scoped: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
    const readInitial = () => initial;
    const readScoped = () => scoped;
    await using lease = await acquireReadOnlyPreparedModelRuntime(
      {
        ...fixture.agentInput("projection", initial),
        readPolicyConfig: readInitial,
      },
      { catalogMode: "static" },
    );
    const row = { provider: "fixture", id: "model", name: "Fixture model" };
    const catalog = { entries: [row], routeVariants: [row] };
    const captured = capturePreparedModelRuntimeCatalog(lease.snapshot, {
      ...lease.snapshot,
      readFullModelCatalog: () => catalog,
    });
    const store = { version: 1, profiles: {} };
    const usageStore = { ...store, usageStats: {} };
    const readUsage = vi.fn(() => usageStore);
    const labels = new Map([["fixture", { all: "Fixture account", apiKey: "Fixture key" }]]);
    const materializations = [
      {
        provider: "fixture",
        modelId: "model",
        modelApi: "responses",
        modelBaseUrl: "https://example.test",
        requestTransportOverrides: "none" as const,
        authMode: "api_key",
        runtimeOwnerId: "projection-owner",
      },
    ];
    const loaded = { authStore: store, authModes: {} };
    const load = vi.fn(async () => loaded);
    bindPreparedModelRuntimeAuth(captured, { store, readUsage, labels, materializations, load });
    const projected = withPreparedModelRuntimePolicyConfig(captured, readScoped);
    expect(projected).not.toBe(captured);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(withPreparedModelRuntimePolicyConfig(captured, readInitial)).toBe(captured);
    expect(projected.config).toBe(captured.config);
    expect(projected.observationConfig).toBe(captured.observationConfig);
    expect(projected.modelCatalog).toBe(captured.modelCatalog);
    expect(projected.createStores).toBe(captured.createStores);
    expect(projected.isCurrent).toBe(captured.isCurrent);
    expect(readCapturedPreparedModelRuntimeCatalog(projected)).toBe(catalog);
    expect(readAdmittedPublishedModelCatalog(projected)).toBe(catalog);
    expect(getPreparedModelRuntimeAuthStore(projected)).toBe(usageStore);
    expect(readUsage).toHaveBeenCalledExactlyOnceWith(store);
    expect(getPreparedModelRuntimeAuthLabels(projected)).toBe(labels);
    expect(getPreparedModelRuntimeAuthMaterializations(projected)).toBe(materializations);
    await expect(
      loadPreparedModelRuntimeAuth(projected, { providerIds: ["fixture"] }),
    ).resolves.toBe(loaded);
    expect(load).toHaveBeenCalledExactlyOnceWith({ providerIds: ["fixture"] });
    expect(getPreparedModelRuntimePolicyConfigReader(projected)!()).toBe(scoped);
    expect(getPreparedModelRuntimePolicyConfigReader(captured)!()).toBe(initial);
    expect(getPreparedModelRuntimeAuthLabels(captured)).toBe(labels);

    const runProjection = Object.freeze({ ...captured, activeProjectKeys: ["fixture-project"] });
    copyPreparedModelRuntimeSnapshotBindings(captured, runProjection);
    expect(runProjection.config).toBe(captured.config);
    expect(runProjection.observationConfig).toBe(captured.observationConfig);
    expect(getPreparedModelRuntimePolicyConfigReader(runProjection)).toBe(readInitial);
    expect(getPreparedModelRuntimeAuthStore(runProjection)).toBe(usageStore);
    expect(getPreparedModelRuntimeAuthLabels(runProjection)).toBe(labels);
    expect(getPreparedModelRuntimeAuthMaterializations(runProjection)).toBe(materializations);
    await expect(
      loadPreparedModelRuntimeAuth(runProjection, { providerIds: ["fixture"] }),
    ).resolves.toBe(loaded);
    expect(readCapturedPreparedModelRuntimeCatalog(runProjection)).toBe(catalog);
    expect(readAdmittedPublishedModelCatalog(runProjection)).toBe(catalog);
    expect(runProjection.createStores).toBe(captured.createStores);
    expect(runProjection.isCurrent).toBe(captured.isCurrent);
    expect(runProjection).not.toHaveProperty("readPolicyConfig");
  });

  it("rebinds an unpinned run without promoting an already admitted scoped lease", async () => {
    const scoped: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
    const live: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    clearRuntimeConfigSnapshot();
    const readScoped = createRuntimeConfigReader(scoped);
    try {
      await refreshPreparedModelRuntimeSnapshots(live, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      setRuntimeConfigSnapshot(live);
      const input = {
        ...fixture.agentInput("default", scoped),
        workspaceDir: "/tmp/unused-workspace",
        readPolicyConfig: readScoped,
      };
      await using retained = await acquireReadOnlyPreparedModelRuntime(input, {
        catalogMode: "static",
      });
      const configured = await prepareModelRuntimeSnapshot({ ...input, config: live });
      const modelBuilds = mocks.ensureOpenClawModelsJson.mock.calls.length;
      await using run = await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" });
      expect(run.snapshot).toBe(configured);
      expect(run.snapshot.config).toBe(live);
      expect(getPreparedModelRuntimePolicyConfigReader(run.snapshot)).toBe(
        getPreparedModelRuntimePolicyConfigReader(configured),
      );
      expect(getPreparedModelRuntimePolicyConfigReader(run.snapshot)!()).toBe(live);
      expect(getPreparedModelRuntimePolicyConfigReader(retained.snapshot)!()).toBe(scoped);
      expect(retained.snapshot.config).toBe(scoped);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(modelBuilds);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("advances without rebuilding or mutating existing readers", async () => {
    const initialConfig = {};
    const nextConfig = hotConfig();
    await publish(initialConfig);
    const input = fixture.agentInput("default", initialConfig);
    const existingReader = await prepareModelRuntimeSnapshot(input);
    const materializations = [
      {
        provider: "test",
        modelId: "model",
        modelApi: "responses",
        modelBaseUrl: "https://example.test",
        requestTransportOverrides: "none" as const,
        authMode: "api_key",
        runtimeOwnerId: "test-owner",
      },
    ];
    bindPreparedModelRuntimeAuth(existingReader, { materializations });
    const authStore = getPreparedModelRuntimeAuthStore(existingReader);
    const loadedAuth = await loadPreparedModelRuntimeAuth(existingReader, { providerIds: [] });
    mocks.configuredAgentDirs.set("default", "/tmp/later-agent");

    advancePreparedModelRuntimeConfig(nextConfig);

    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced).not.toBe(existingReader);
    expect(advanced.config).toBe(nextConfig);
    expect(existingReader.config).toBe(initialConfig);
    expectOwner(advanced, nextConfig);
    expect(getPreparedModelRuntimeAuthStore(advanced)).toBe(authStore);
    expect(getPreparedModelRuntimeAuthMaterializations(advanced)).toBe(materializations);
    await expect(loadPreparedModelRuntimeAuth(advanced, { providerIds: [] })).resolves.toEqual(
      loadedAuth,
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(dispatch()).resolves.toMatchObject({ config: nextConfig });
  });

  it("keeps native observation and selection facts on their discovery config after a stamp advances", async () => {
    const runtime = "native-observation-fixture";
    const row = { provider: "custom", id: "model", name: "Native model", nativeRuntime: runtime };
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "custom/model",
          models: { "custom/model": { agentRuntime: { id: runtime } } },
        },
      },
      plugins: { entries: { [runtime]: { config: { home: "synthetic-home" } } } },
    };
    const observations = new WeakMap<
      OpenClawConfig,
      { agentDir: string; workspaceDir: string; pluginConfig: unknown }
    >();
    const loadModelCatalog = vi.fn(async (params: AgentHarnessModelCatalogParams) => {
      observations.set(params.config, {
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        pluginConfig: params.config.plugins?.entries?.[runtime]?.config,
      });
      return [row];
    });
    const registry = harnessRegistry(runtime, {
      authBootstrap: "harness",
      loadModelCatalog,
      readModelCatalogReadiness: (params) => {
        const observed = observations.get(params.config);
        return observed !== undefined &&
          observed.agentDir === params.agentDir &&
          observed.workspaceDir === params.workspaceDir &&
          observed.pluginConfig === params.config.plugins?.entries?.[runtime]?.config
          ? { accountType: "chatgpt", authMode: "oauth" }
          : undefined;
      },
    });
    mocks.resolveNativeModelPrimary.mockReturnValue("custom/model");
    mocks.configuredWorkspaces.set("default", fixture.state.workspaceDir);
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    await publish(config, { catalogMode: "static" });
    const input = { config, agentId: "default", agentDir: fixture.state.agentDir("default") };
    const snapshot = await prepareModelRuntimeSnapshot(input);
    const catalog = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(catalog.entries).toContainEqual(expect.objectContaining(row));
    const discovery = loadModelCatalog.mock.calls.at(-1)![0];
    const evaluate = (
      reader: typeof snapshot,
      observationConfig = reader.observationConfig,
      agentDir = reader.agentDir,
    ) =>
      prepareModelCatalogView({
        cfg: reader.config,
        agentId: "default",
        agentDir,
        workspaceDir: fixture.state.workspaceDir,
        snapshot: catalog,
        metadataSnapshot: reader.metadataSnapshot,
        pluginRegistry: reader.pluginRegistry,
        isCurrent: reader.isCurrent,
        observationConfig,
      }).evaluateNative(row, { availability: false, routeResolution: null }, runtime);
    expect(evaluate(snapshot)).toMatchObject({ availability: true, selectedAuthMode: "oauth" });
    expect(snapshot.config).toBe(config);
    expect(snapshot.observationConfig).toBe(discovery.config);
    const nextConfig = { ...config, logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(nextConfig);
    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced.config).toBe(nextConfig);
    expect(advanced.observationConfig).toBe(discovery.config);
    expect(evaluate(advanced).availability).toBe(true);
    expect(evaluate(advanced, { ...discovery.config }).availability).toBe(false);
    expect(evaluate(advanced, discovery.config, fixture.state.agentDir("other")).availability).toBe(
      false,
    );
    observations.delete(discovery.config);
    expect(evaluate(advanced).availability).toBe(false);
  });

  it("resolves startup config inside the serialized publication", async () => {
    const nextConfig = hotConfig();
    let currentConfig: OpenClawConfig = {};

    const publication = publish(() => currentConfig);
    currentConfig = nextConfig;
    advancePreparedModelRuntimeConfig(nextConfig);
    await publication;

    await expectPublished(nextConfig);
  });

  it.each(["before hydration", "during hydration"])(
    "keeps reply admission active when startup is superseded %s",
    async (timing) => {
      const staleConfig = {};
      const nextConfig = hotConfig();
      await using resources = new AsyncDisposableStack();
      const stale = holdPublication(resources, staleConfig, {
        startup: true,
        catalogMode: "static",
      });
      if (timing === "during hydration") {
        await stale.started;
      }
      const next = refreshPreparedModelRuntimeSnapshots(nextConfig, {
        agentIds: new Set(["default"]),
        catalogMode: "static",
      });
      resources.defer(async () => {
        stale.release();
        await Promise.allSettled([next]);
      });
      stale.release();
      await Promise.all([stale.pending, next]);
      await expectPublished(nextConfig);
    },
  );

  it.each(["standalone", "rejected", "shutdown-fenced"])(
    "does not activate Gateway reply admission for a %s refresh",
    async (kind) => {
      const refresh = () =>
        refreshPreparedModelRuntimeSnapshots(
          {},
          {
            gatewayLifecycle: kind !== "standalone",
            isPublicationCurrent: () => kind !== "rejected",
            catalogMode: "static",
          },
        );
      if (kind === "shutdown-fenced") {
        cancelPreparedModelRuntimeRefresh();
        expect(refresh).toThrow("shutdown");
      } else {
        await refresh();
      }
      await expect(dispatch()).resolves.toBeUndefined();
    },
  );

  it("drops a publication whose lifecycle claim is lost during async config resolution", async () => {
    const staleConfig = { gateway: { reload: { mode: "off" as const } } };
    const nextConfig = hotConfig();
    await publish({});
    await using resources = new AsyncDisposableStack();
    let claimCurrent = true;
    const stale = holdPublication(resources, staleConfig, {
      isPublicationCurrent: () => claimCurrent,
    });
    resources.defer(() => {
      claimCurrent = false;
    });
    await stale.started;
    const readerSettled = vi.fn();
    const reader = prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config: staleConfig,
    }).then(readerSettled, readerSettled);
    claimCurrent = false;
    stale.release();
    await stale.pending;
    // A lost external claim must settle readers without requiring a replacement.
    await vi.waitFor(() => expect(readerSettled).toHaveBeenCalledWith(expect.any(Error)));
    await reader;
    await publish(nextConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    await expectPublished(nextConfig);
  });

  it("keeps an in-flight auth publication on the advanced stamp", async () => {
    const nextConfig = hotConfig();
    await publish({});
    const authRefresh = createEnteredGate();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
      await authRefresh.wait();
      return {};
    });

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await authRefresh.entered;
      mocks.configuredAgentDirs.set("default", "/tmp/later-agent");
      advancePreparedModelRuntimeConfig(nextConfig);
      authRefresh.release();

      const snapshot = await prepare(nextConfig);
      expectOwner(snapshot, nextConfig);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      authRefresh.release();
      await Promise.allSettled([dispatch()]);
    }
  });
});
