// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { applyAgentConfig, pruneAgentConfig } from "../commands/agents.config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffConfigPaths } from "../gateway/config-diff.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { createGatewayModelRuntimeReload } from "../gateway/server-reload-model-runtime-scope.js";
import { registryContainsRuntimePluginIds } from "../plugins/active-runtime-registry.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { DiscoverAuthStorageOptions } from "./agent-auth-discovery.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { harnessRegistry } from "./model-catalog-fixtures.test-support.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  acquireAgentRunPreparedModelRuntime,
  beginPreparedModelRuntimePluginDrain,
  ensureGatewayPreparedModelRuntimeReady,
  getPendingPreparedModelRuntimeReplacement,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  recoverPreparedModelRuntimeCatalogWorker,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
  rejectPendingPreparedModelRuntimeReplacement,
  retirePreparedModelRuntimeAgent,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { loadSubagentRegistryPluginRuntimeHandle } from "./subagents/registry/subagent-registry-deps.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
type Dispatch = NonNullable<Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>>;
type RunInput = Parameters<typeof acquireAgentRunPreparedModelRuntime>[0];
type RuntimeSelections = RunInput["runtimePluginSelections"];

function runInput(dispatch: Dispatch, runtimePluginSelections: RuntimeSelections) {
  const { config, agentId, agentDir, workspaceDir } = dispatch;
  return { config, agentId, agentDir, workspaceDir, runtimePluginSelections };
}

function catalogGate(onRelease?: () => void) {
  const started = createDeferred();
  const finish = createDeferred();
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    onRelease?.();
    return { entries: [] };
  });
  return { started: started.promise, finish: () => finish.resolve() };
}

const prepareGroup = (
  input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number],
  previous?: Parameters<typeof prepareWorkspaceBuildGroup>[4],
  preparedMetadata?: Parameters<typeof prepareWorkspaceBuildGroup>[5],
  resolveRegistry?: Parameters<typeof prepareWorkspaceBuildGroup>[3],
) => prepareWorkspaceBuildGroup([input], "static", {}, resolveRegistry, previous, preparedMetadata);

function publication(phase: "published" | "failed") {
  const ready = createDeferred();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === phase) {
      ready.resolve();
    }
  });
  return () => ready.promise.finally(unregister);
}

function provider(id: string, apiKey?: string): ProviderPlugin {
  const plugin: ProviderPlugin = { id, label: id, auth: [] };
  if (apiKey) {
    plugin.resolveSyntheticAuth = () => ({ apiKey, source: "fixture", mode: "api-key" });
  }
  return plugin;
}

const metadata = (config: OpenClawConfig, plugins: Parameters<typeof makeRegistry>[0] = []) =>
  createPluginMetadataSnapshot({ config, manifestRegistry: makeRegistry(plugins) });

const publishGateway = (
  config: OpenClawConfig = {},
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) =>
  refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    ...options,
  });

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
  it("reuses the published workspace registry for repeated subagent cleanup", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await publishGateway(config, { allowGatewaySubagentBinding: true });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const input = { ...runInput(published, undefined), allowGatewaySubagentBinding: true };
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
    const loadSubagent = (overrides: Partial<typeof input> = {}) =>
      loadSubagentRegistryPluginRuntimeHandle({ ...input, ...overrides });
    expect(await loadSubagent()).toBe(published.inboundPluginRegistry);
    expect(await loadSubagent()).toBe(published.inboundPluginRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();

    const replacementConfig = { plugins: { enabled: false } };
    await publishGateway(replacementConfig, { allowGatewaySubagentBinding: true });
    const replacement = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
    const replacementRegistry = await loadSubagent({ config: replacementConfig });
    expect(replacementRegistry).toBe(replacement.inboundPluginRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();

    // Historical workspaces and changed policy cannot borrow the current publication.
    for (const unmatched of [
      input,
      { ...input, config: replacementConfig, workspaceDir: fixture.state.path("old-workspace") },
    ]) {
      const unmatchedRegistry = await loadSubagentRegistryPluginRuntimeHandle(unmatched);
      expect(unmatchedRegistry).not.toBe(replacement.inboundPluginRegistry);
    }
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
  });

  it("holds inspected input through accepted preparation and refuses a retired result", async () => {
    const database = new DatabaseSync(fixture.state.path("prepared-registration.sqlite"));
    database.exec(
      "CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)",
    );
    const registry = createEmptyPluginRegistry();
    const resources = new PluginRegistryInspectionResources(async () => {});
    resources.attach(registry);
    const dispose = vi.fn(() => database.close());
    resources.runRegistration("prepared-native", () => {
      resources.register("prepared-native", {
        id: "sqlite",
        dispose,
      });
    });
    let observedValue: unknown;
    const gate = catalogGate(() => {
      observedValue = database.prepare("SELECT value FROM observations").get()?.value;
    });
    const config = {};
    const preparation = prepareGroup(
      {
        config,
        agentDir: fixture.state.agentDir("default"),
        workspaceDir: fixture.state.workspaceDir,
        env: fixture.state.env,
        skipCredentials: true,
      },
      undefined,
      metadata(config),
      () => registry,
    );
    const outcome = preparation.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        gate.started,
        preparation,
        "Preparation completed before its static catalog dependency",
      );
      await resources.release();
      expect(database.isOpen).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      gate.finish();
      expect(await outcome).toEqual(new Error("Plugin inspection resources have been released"));
      expect(observedValue).toBe(42);
      expect(database.isOpen).toBe(false);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      gate.finish();
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
      provider: provider("selected", "synthetic-provider-fixture"),
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      params.selections?.some(
        (selection: { provider: string }) => selection.provider === "selected",
      )
        ? selectedRegistry
        : (params.reusableRegistry ?? createEmptyPluginRegistry()),
    );
    await publishGateway(config);
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const selection = { provider: "selected", modelId: "model", runtime: "openclaw" as const };
    const input = { ...runInput(published, [selection]), config };
    const lease = await acquireAgentRunPreparedModelRuntime(input, {
      catalogMode: "static",
      pluginGeneration: published.pluginGeneration,
    });
    expect(lease.snapshot.pluginRegistry === selectedRegistry).toBe(true);
    expect(lease.snapshot.authModes.selected).toBe("api_key");
    expect(published.pluginGeneration.preparedStaticProviderCatalog?.providers).toBeUndefined();
    await lease[Symbol.asyncDispose]();
    const publishedRefresh = publication("published");
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await publishedRefresh();
    expect(getPreparedModelRuntimeSnapshot(input)?.authModes.selected).toBe("api_key");
  });

  it("isolates selected run owners while retaining the published generation and lease lifetime", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "custom/model" } } };
    const runtimes = ["first-harness", "second-harness"];
    const registries = new Map(
      runtimes.map((runtime) => {
        const registry = harnessRegistry(runtime);
        registry.agentHarnesses[0]!.source = "test";
        return [runtime, registry] as const;
      }),
    );
    const loadRegistry = mocks.loadAgentRuntimePluginRegistryHandle;
    loadRegistry.mockImplementation(
      (params) => registries.get(params.selections?.[0]?.runtime) ?? createEmptyPluginRegistry(),
    );
    const manifests = runtimes.map((id) => ({
      id,
      origin: "bundled" as const,
      channels: [],
      activation: { onStartup: false, onAgentHarnesses: [id] },
    }));
    await publishGateway(config, {
      allowGatewaySubagentBinding: true,
      pluginMetadataSnapshot: metadata(config, manifests),
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const acquire = (
      runtime: string,
      pluginGeneration = published.pluginGeneration,
      catalogMode?: "static",
      overrides: Partial<RunInput> = {},
    ) =>
      acquireAgentRunPreparedModelRuntime(
        {
          ...runInput(published, [{ provider: "custom", modelId: "model", runtime }]),
          config,
          allowGatewaySubagentBinding: true,
          ...overrides,
        },
        { pluginGeneration, catalogMode },
      );
    const expectSuperseded = async (
      result: ReturnType<typeof acquireAgentRunPreparedModelRuntime>,
      scope?: string,
    ) => {
      const failures = (
        await Promise.allSettled([
          result.then(
            (lease) => lease[Symbol.asyncDispose](),
            () => undefined,
          ),
          expect(result, scope).rejects.toThrow("plugin generation was superseded"),
        ])
      ).flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
      if (failures.length) {
        throw new AggregateError(
          failures,
          `${scope ?? "runtime scope"} rejection or cleanup failed`,
        );
      }
    };
    await using acquiredLeases = new AsyncDisposableStack();
    const initial = await Promise.allSettled(
      runtimes.map((runtime) => acquire(runtime, published.pluginGeneration, "static")),
    );
    const leases = initial.map((result) =>
      result.status === "fulfilled" ? acquiredLeases.use(result.value) : undefined,
    );
    const failed = initial.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
    const loadsBeforeExecutionWorkspaces = loadRegistry.mock.calls.length;
    for (const [index, runtime] of runtimes.entries()) {
      const lease = leases[index]!;
      expect(lease.snapshot.pluginRegistry === registries.get(runtime)).toBe(true);
      expect(lease.snapshot.metadataSnapshot).toBe(
        published.pluginGeneration.pluginMetadataSnapshot,
      );
      expect(lease.pluginGeneration.inboundPluginRegistry).toBe(published.inboundPluginRegistry);
      expect(Object.isFrozen(lease.pluginGeneration)).toBe(true);
      await using repeated = await acquire(runtime, published.pluginGeneration, "static");
      expect(repeated.snapshot === lease.snapshot).toBe(true);
      expect(repeated.pluginGeneration === lease.pluginGeneration).toBe(true);
      await repeated[Symbol.asyncDispose]();
      await using scopedLease = scopePreparedModelRuntimeLease(lease);
      await scopedLease.run(async () => {
        await using nested = await acquire(runtime, lease.pluginGeneration);
        expect(nested.snapshot === lease.snapshot).toBe(true);
        await nested[Symbol.asyncDispose]();
        await using executionWorkspace = await acquire(runtime, lease.pluginGeneration, "static", {
          workspaceDir: fixture.state.path(`execution-${runtime}`),
        });
        expect(executionWorkspace.pluginGeneration).toBe(lease.pluginGeneration);
        expect(executionWorkspace.snapshot.workspaceDir).toBe(
          fixture.state.path(`execution-${runtime}`),
        );
        await executionWorkspace[Symbol.asyncDispose]();
        const scopeMismatches: Array<readonly [string, Partial<RunInput>]> = [
          ["config", { config: { agents: { defaults: { model: "other/model" } } } }],
          ["inherited auth", { inheritedAuthDir: fixture.state.path("other-auth") }],
          ["environment", { env: { OPENCLAW_PREPARED_RUNTIME_TEST_SCOPE: "different" } }],
          ["agent", { agentId: "other" }],
          ["agent directory", { agentDir: fixture.state.agentDir("other") }],
          ["missing selection", { runtimePluginSelections: undefined }],
        ];
        for (const [scope, overrides] of scopeMismatches) {
          await expectSuperseded(
            acquire(runtime, lease.pluginGeneration, "static", {
              workspaceDir: fixture.state.path(`mismatch-${runtime}`),
              ...overrides,
            }),
            scope,
          );
        }
        await expectSuperseded(acquire(runtimes[1 - index]!, lease.pluginGeneration));
        await scopedLease[Symbol.asyncDispose]();
        await expectSuperseded(acquire(runtime, lease.pluginGeneration));
      });
    }
    expect(await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).toBe(published);
    expect(published.pluginGeneration.pluginRegistry?.agentHarnesses).toEqual([]);
    expect(loadRegistry).toHaveBeenCalledTimes(loadsBeforeExecutionWorkspaces + registries.size);
    const retirementRuntime = [...registries.keys()][0]!;
    await using retirementLease = scopePreparedModelRuntimeLease(
      await acquire(retirementRuntime, published.pluginGeneration, "static"),
    );
    await retirementLease.run(async () => {
      await retirePreparedModelRuntimeAgent({
        agentId: "default",
        agentDirs: [published.agentDir],
      });
      await expectSuperseded(
        acquire(retirementRuntime, retirementLease.pluginGeneration, "static", {
          workspaceDir: fixture.state.path("workspace-after-agent-retirement"),
        }),
      );
    });
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
      const pluginMetadata = metadata(config, [
        { id: "qwen", origin: "bundled", channels: [], providers: ["bailian-token-plan"] },
      ]);
      await publishGateway(config, {
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: {
          ...pluginMetadata,
          owners: {
            ...pluginMetadata.owners,
            providers: new Map([["bailian-token-plan", ["qwen"]]]),
          },
        },
      });
      const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
      const pick = {
        provider: "bailian-token-plan",
        modelId: "qwen3.7-max",
        runtime: "openclaw" as const,
      };
      const input = { ...runInput(published, [pick]), config, allowGatewaySubagentBinding: true };
      await using parent = scopePreparedModelRuntimeLease(
        await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
          pluginGeneration: published.pluginGeneration,
        }),
      );
      expect(parent.pluginGeneration).not.toBe(published.pluginGeneration);
      await parent.run(async () => {
        const borrowing = acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
          pluginGeneration: parent.pluginGeneration,
        });
        if (outcome === "not-imported") {
          await expect(borrowing).rejects.toThrow("plugin generation was superseded");
          return;
        }
        await using nested = await borrowing;
        expect(nested.snapshot).toBe(parent.snapshot);
        expect(registryContainsRuntimePluginIds(registry, ["qwen"])).toBe(false);
        if (outcome === "error") {
          expect(nested.snapshot.pluginRegistry?.plugins[0]?.error).toBe(
            "provider fixture failed to load",
          );
        }
      });
    },
  );

  it.each(["add", "delete"] as const)(
    "keeps unchanged turns admitted across overlapping agent %s reloads",
    async (successor) => {
      const initialConfig: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { model: "openai/gpt-5.5" },
          entries: { free: {}, other: {} },
        },
      };
      mocks.configuredAgentIds = ["free", "other"];
      mocks.usePersistedAuthProfiles = true;
      const publishAuth = (config: OpenClawConfig) =>
        replaceRuntimeAuthProfileStoreSnapshots(
          Object.keys(config.agents!.entries!).map((id) => ({
            agentDir: fixture.state.agentDir(id),
            store: { version: 1, profiles: {} },
          })),
        );
      publishAuth(initialConfig);
      const firstConfig = applyAgentConfig(initialConfig, { agentId: "first" });
      const latestConfig =
        successor === "add"
          ? applyAgentConfig(firstConfig, { agentId: "second" })
          : pruneAgentConfig(firstConfig, "other").config;
      const reload = createGatewayModelRuntimeReload();
      const prepare = (previous: OpenClawConfig, next: OpenClawConfig) =>
        reload.prepare(buildGatewayReloadPlan(diffConfigPaths(previous, next)), previous, next);
      const options = {
        gatewayLifecycle: true,
        catalogMode: "static" as const,
        allowGatewaySubagentBinding: true,
        joinSupersedingPublication: true,
      };
      await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
      await using resources = new AsyncDisposableStack();
      let captured: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
      const dispatch = (await loadPublishedGatewayReplyDispatchRuntime({
        agentId: "free",
        onRuntimeLease: (lease) => {
          captured = resources.use(scopePreparedModelRuntimeLease(lease));
        },
      }))!;
      const gate = catalogGate();
      mocks.configuredAgentIds = ["free", "other", "first"];
      const firstScope = prepare(initialConfig, firstConfig);
      publishAuth(firstConfig);
      const first = refreshPreparedModelRuntimeSnapshots(firstConfig, {
        ...options,
        ...firstScope.scope,
      });
      let second: Promise<void> | undefined;
      try {
        await gate.started;
        firstScope.defer();
        mocks.configuredAgentIds = Object.keys(latestConfig.agents!.entries!);
        const secondScope = prepare(firstConfig, latestConfig);
        publishAuth(latestConfig);
        markPreparedModelRuntimeSnapshotsStale(undefined, {
          waitForReplacement: true,
          ...secondScope.scope,
        });
        second = refreshPreparedModelRuntimeSnapshots(latestConfig, {
          ...options,
          ...secondScope.scope,
        });
        gate.finish();
        await Promise.all([first, second]);

        const admissionInput = {
          ...runInput(dispatch, [{ provider: "openai", modelId: "gpt-5.5" }]),
          allowGatewaySubagentBinding: true,
        };
        await using pendingTurn = await acquireAgentRunPreparedModelRuntime(admissionInput, {
          pluginGeneration: dispatch.pluginGeneration,
        });
        expect(pendingTurn.pluginGeneration).toBe(dispatch.pluginGeneration);
        await captured!.run(async () => {
          await using resumed = await acquireAgentRunPreparedModelRuntime(admissionInput, {
            pluginGeneration: dispatch.pluginGeneration,
          });
          expect(resumed.pluginGeneration).toBe(dispatch.pluginGeneration);
        });
        const latest = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "free" }))!;
        expect(latest.pluginGeneration).toBe(dispatch.pluginGeneration);
        expect(latest.config).toBe(latestConfig);
        await using admitted = await acquireAgentRunPreparedModelRuntime({
          ...fixture.agentInput("free", latestConfig),
          workspaceDir: latest.workspaceDir,
          allowGatewaySubagentBinding: true,
        });
        expect(admitted.snapshot.config).toBe(latestConfig);
        for (const agentId of mocks.configuredAgentIds.filter((id) => id !== "free")) {
          expect(await loadPublishedGatewayReplyDispatchRuntime({ agentId })).toMatchObject({
            agentId,
            config: latestConfig,
          });
        }
      } finally {
        gate.finish();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("keeps unaffected dispatch and run admission available when a scoped replacement fails", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    const input = fixture.agentInput("default", {});
    await publishGateway(input.config);
    const original = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const gate = markPreparedModelRuntimeSnapshotsStale("worker agent reload", {
      waitForReplacement: true,
      agentIds: new Set(["worker"]),
    });
    await using leases = new AsyncDisposableStack();
    const retainLease = <T extends PreparedModelRuntimeLease>(lease: T) => leases.use(lease);
    const reading = Promise.all([
      loadPublishedGatewayReplyDispatchRuntime({
        agentId: "default",
        onRuntimeLease: retainLease,
      }),
      prepareModelRuntimeSnapshot(input),
      acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" }).then(retainLease),
    ]);
    const observed = reading.catch((error: unknown) => error);
    try {
      // Join the same healthy demand preflight while the other agent's reload remains pending.
      await ensureGatewayPreparedModelRuntimeReady({ agentId: "default" });
      rejectPendingPreparedModelRuntimeReplacement(gate, new Error("worker database is closing"));
      const [dispatch, snapshot, lease] = await reading;
      expect(dispatch).toMatchObject({
        agentId: "default",
        pluginGeneration: original?.pluginGeneration,
      });
      expect(snapshot.isCurrent()).toBe(true);
      expect(lease.snapshot.isCurrent()).toBe(true);
      const retained = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      await expect(retained).resolves.toBe(original);
      await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).rejects.toThrow(
        "was not published for worker",
      );
    } finally {
      rejectPendingPreparedModelRuntimeReplacement(gate, new Error("test cleanup"));
      await observed;
    }
  });

  it("recovers a rejected auth refresh projection without affecting siblings", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await publishGateway();
    const defaultRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const refreshFailed = publication("failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new Error("auth refresh rejected");
    });

    mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    await refreshFailed();

    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" }),
    ).resolves.toMatchObject({ agentId: "worker" });
    const retained = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(retained?.pluginGeneration).toBe(defaultRuntime?.pluginGeneration);
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
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
      finishAuthRefresh = () => finishAuthRefreshGate.resolve();
      await finishAuthRefreshGate.promise;
      return {};
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
      await using lease = await acquireAgentRunPreparedModelRuntime(input);
      expect(lease.snapshot).toMatchObject({
        agentId: "default",
        agentDir: input.agentDir,
        workspaceDir: "/tmp/unused-workspace",
      });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
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
      provider: provider("runtime-provider"),
    });
    // A discovery entry may expose auth absent from the runtime registration.
    const discovery = instance.wrap(provider("discovery-auth", `synthetic-${version}-not-real`));
    return { registry, instance, discovery };
  };
  const previous = createRuntime("previous");
  const successor = createRuntime("successor");
  const registry = successor.registry;
  const added = createPluginRecord({ id: "selected-owner" });
  registry.plugins.push(added);
  const addedInstance = new PluginInstance(added.id, { record: added, registry });
  registry.providers.push({
    pluginId: added.id,
    source: added.source,
    provider: provider("selected-provider"),
  });
  const discoveries = new Map([
    [previous.registry, previous.discovery],
    [registry, successor.discovery],
  ]);
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    const activeRegistry = getPluginRuntimeGenerationRegistry();
    const discovery = activeRegistry && discoveries.get(activeRegistry);
    if (!discovery) {
      throw new Error("Static discovery must run under its selected runtime registry");
    }
    return { entries: [], providers: [discovery] };
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
    params.selections?.some(
      (selection: { provider: string }) => selection.provider === "selected-provider",
    )
      ? registry
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
  const pluginMetadata = metadata(input.config, [
    { id: "catalog-owner", providers: ["runtime-provider", "discovery-auth"], channels: [] },
    { id: "selected-owner", providers: ["selected-provider"], channels: [] },
  ]);
  const first = await prepareGroup(input, undefined, pluginMetadata);
  const releasePrevious = retainPreparedPluginGeneration(first.pluginGeneration);
  await using lifecycle = new AsyncDisposableStack();
  lifecycle.defer(async () => {
    await addedInstance.dispose();
  });
  const releases: { successor?: () => Promise<void> } = {};
  lifecycle.defer(() => releases.successor?.());
  lifecycle.defer(releasePrevious);
  expect(first.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
    key: "synthetic-previous-not-real",
  });
  const replacement = await prepareGroup(expandedInput, first.pluginGeneration);
  expect(replacement.pluginGeneration.pluginRegistry).toBe(registry);
  expect(replacement.pluginGeneration.pluginRegistry).not.toBe(
    first.pluginGeneration.pluginRegistry,
  );
  releases.successor = retainPreparedPluginGeneration(replacement.pluginGeneration);
  await releasePrevious();
  expect(previous.instance.lifecycle.signal.aborted).toBe(true);
  const refreshed = await prepareGroup(expandedInput, replacement.pluginGeneration);
  expect(refreshed.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
    key: "synthetic-successor-not-real",
  });
});

describe("catalog-worker replacement demand", () => {
  const dispatch = (demand: "interactive" | "scheduled" = "interactive") =>
    loadPublishedGatewayReplyDispatchRuntime({ agentId: "default", demand });
  async function failReplacement(snapshot?: PreparedModelRuntimeSnapshot, agentIds = ["default"]) {
    const input = fixture.agentInput("default", snapshot?.config ?? {});
    if (!snapshot) {
      mocks.configuredAgentIds = agentIds;
      await publishGateway(input.config, { allowGatewaySubagentBinding: true });
    }
    const prepared = snapshot ?? (await prepareModelRuntimeSnapshot(input));
    const failure = new Error("catalog replacement preparation failed");
    mocks.resolveAmbientCredentials.mockRejectedValueOnce(failure);
    await expect(recoverPreparedModelRuntimeCatalogWorker([prepared])).rejects.toBe(failure);
    return { input, failure };
  }

  it.each(["successful", "failed"] as const)(
    "shares a %s demand replacement without activating pure snapshot reads",
    async (outcome) => {
      const { input, failure } = await failReplacement();
      mocks.resolveAmbientCredentials.mockClear();
      await expect(prepareModelRuntimeSnapshot(input)).rejects.toMatchObject({
        message: failure.message,
        stack: failure.stack,
      });
      expect(mocks.resolveAmbientCredentials).not.toHaveBeenCalled();
      const started = createDeferred();
      const finish = createDeferred();
      mocks.resolveAmbientCredentials.mockImplementationOnce(() => {
        started.resolve();
        return finish.promise.then(() => {
          if (outcome === "failed") {
            throw failure;
          }
          return {};
        });
      });
      const foreground = dispatch();
      let background: ReturnType<typeof dispatch> | undefined;
      try {
        expect(await Promise.race([started.promise, foreground])).toBeUndefined();
        background = dispatch("scheduled");
        const shared = Promise.all([foreground, background]);
        finish.resolve();
        if (outcome === "failed") {
          await shared.catch(() => undefined);
          await expect(foreground).rejects.toMatchObject({
            reason: "attempt-failed",
            cause: failure,
          });
          await expect(background).rejects.toMatchObject({
            reason: "attempt-failed",
            cause: failure,
          });
          await expect(dispatch("scheduled")).rejects.toThrow("was not published");
          expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
          return;
        }
        const [recovered, joined] = await shared;
        expect(recovered).toMatchObject({ agentId: "default", config: input.config });
        expect(joined).toBe(recovered);
        expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await Promise.allSettled([foreground, background]);
      }
    },
  );

  it("limits scheduled checks to one per failure, retaining foreground recovery after cooldown", async () => {
    const { input } = await failReplacement();
    using clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repeatedFailure = new Error("catalog replacement still fails");
    mocks.resolveAmbientCredentials.mockClear().mockImplementation(() => {
      throw repeatedFailure;
    });
    await expect(dispatch("scheduled")).rejects.toMatchObject({ cause: repeatedFailure });
    await expect(dispatch()).rejects.toThrow("was not published");
    clock.mockReturnValue(20_000);
    await expect(dispatch("scheduled")).rejects.toThrow("was not published");
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
    await expect(dispatch()).rejects.toMatchObject({ cause: repeatedFailure });
    clock.mockReturnValue(30_000);
    await expect(dispatch("scheduled")).rejects.toThrow("was not published");
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
    mocks.resolveAmbientCredentials.mockReturnValue({});
    expect(await dispatch()).toMatchObject({ agentId: "default" });
    await failReplacement(await prepareModelRuntimeSnapshot(input));
    expect(await dispatch("scheduled")).toMatchObject({ agentId: "default" });
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(5);
  });
  it("does not spend the scheduled check while waiting for an unrelated failed replacement", async () => {
    await failReplacement(undefined, ["default", "other"]);
    const drain = beginPreparedModelRuntimePluginDrain();
    const waiting = dispatch("scheduled");
    const prematureReplacement = getPendingPreparedModelRuntimeReplacement();
    const gate = markPreparedModelRuntimeSnapshotsStale("other agent reload", {
      waitForReplacement: true,
      agentIds: new Set(["other"]),
    });
    const unrelatedFailure = new Error("other agent reload failed");
    const rejected = expect(waiting).rejects.toBe(unrelatedFailure);
    drain.release();
    await Promise.resolve();
    rejectPendingPreparedModelRuntimeReplacement(gate, unrelatedFailure);
    await rejected;
    expect(prematureReplacement).toBeUndefined();
    mocks.resolveAmbientCredentials.mockClear();
    expect(await dispatch("scheduled")).toMatchObject({ agentId: "default" });
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalled();
  });
});
