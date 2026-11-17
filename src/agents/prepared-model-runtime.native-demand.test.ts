// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe } from "vitest";
import { beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { invalidateOperatorRolePolicy } from "../gateway/operator-role-policy.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createModelsListTestContext } from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import {
  createOwnedTestInstance,
  createTestInstance,
} from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveEmbeddedRunModelSetup } from "./embedded-agent-runner/run/model-setup.js";
import { type AgentHarnessModelCatalogResult } from "./harness/types.js";
import type { AgentHarness } from "./harness/types.js";
import { harnessRegistry, snapshot } from "./model-catalog-fixtures.test-support.js";
import { type ModelCatalogEntry } from "./model-catalog.types.js";
import { type ModelCatalogSnapshot } from "./model-catalog.types.js";
import { loadPreparedModelCatalogSnapshot as loadCatalog } from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { acquirePreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { getPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { markPreparedModelRuntimeSnapshotsStale } from "./prepared-model-runtime.js";
import { publishPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import {
  getPreparedModelRuntimeSnapshot as readSnapshot,
  markPreparedModelRuntimeSnapshotsStale as invalidate,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { type PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import { type PreparedModelRuntimeLease } from "./prepared-model-runtime.types.js";
import { type PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

const fixture = usePreparedModelRuntimeHarness({ label: "native-demand" });
const { mocks } = fixture;
beforeEach(() => {
  mocks.configuredAgentIds = ["pro"];
});

function installHarnesses(
  ...harnesses: (Pick<AgentHarness, "id" | "loadModelCatalog"> &
    Partial<Pick<AgentHarness, "label" | "authBootstrap" | "readModelCatalogReadiness">>)[]
) {
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    for (const harness of harnesses) {
      registry.agentHarnesses.push(...harnessRegistry(harness.id, harness).agentHarnesses);
    }
    return registry;
  });
}

function modelsResult(models: object[], extra = {}) {
  return expect.objectContaining({
    models: expect.arrayContaining(models.map((model) => expect.objectContaining(model))),
    ...extra,
  });
}

function expectModels(respond: ReturnType<typeof vi.fn>, models: object[], extra = {}) {
  expect(respond.mock.calls).toEqual([[true, modelsResult(models, extra), undefined]]);
}

function nativeModel(provider: string, id: string, nativeRuntime: string, name = "Native model") {
  return { provider, id, nativeRuntime, name };
}

const saved = { provider: "custom", id: "saved-model", name: "Saved model" };

function nativeConfig(
  model: string,
  models: NonNullable<AgentDefaultsConfig["models"]>,
  agentIds = ["pro"],
): OpenClawConfig {
  return {
    agents: {
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: { model, models },
    },
  };
}

function publish(config: OpenClawConfig) {
  return refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

async function prepareOwner(
  config: OpenClawConfig,
  options: PreparedModelCatalogRefreshOptions = { changedOnly: true },
) {
  await publish(config);
  const owner = readSnapshot(fixture.agentInput("pro", config))!;
  await owner.loadFullModelCatalog!(options);
  return owner;
}

it("serves published models while native discovery outlives the requesting scope", async ({
  signal,
}) => {
  const config: OpenClawConfig = {
    agents: {
      entries: { pro: {} },
      defaults: { model: "custom/saved-model", modelPolicy: { allow: ["custom/*"] } },
    },
  };
  const discovered = { provider: "custom", id: "discovered-model", name: "Discovered model" };
  const started = createDeferredCore();
  const release = createDeferredCore();
  const instance = createOwnedTestInstance("native-test");
  const scope = new PluginInvocationScope(instance.owner!.registry!, [instance]);
  const loadNative = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return instance.run(() => [discovered]);
  });
  installHarnesses({ id: "native-test", loadModelCatalog: loadNative });
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(snapshot([saved]));
  const owner = await prepareOwner(config);
  const sessionKey = "agent:pro:catalog-reader";
  setRuntimeConfigSnapshot(config);
  await upsertSessionEntryCore(
    { agentId: "pro", sessionKey },
    { sessionId: "catalog-reader", updatedAt: 1 },
  );
  const pick = createPicker(config, { sessionKey, view: "configured" });
  // Freeze the foreground discovery deadline: returning on timeout is still blocking.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const requests = Array.from({ length: 3 }, () => scope.run(pick));
  try {
    await withinTest(started.promise, signal);
    for (const response of await withinTest(Promise.all(requests), signal)) {
      expectModels(response, [saved]);
    }
    scope.release();
    release.resolve();
    await owner.loadNativeModelCatalog!();
    expectModels(await pick(), [discovered]);
    expect(loadNative).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    vi.useRealTimers();
    await Promise.allSettled(requests);
  }
});

function createPicker(
  config: OpenClawConfig,
  pickerParams: {
    sessionKey?: string;
    view?: "all" | "configured";
    preparedOnly?: boolean;
    provider?: string;
  } = {},
) {
  const context = createModelsListTestContext({ agentId: "pro", cfg: config, catalog: [] });
  registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
    loadDeferred: (params) =>
      loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config }),
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
  });
  context.readPreparedModelsList = (request) =>
    buildModelsListResult({ source: { kind: "gateway", context }, ...request });
  return async (refresh = false) => {
    const respond = vi.fn();
    await modelsHandlers["models.list"]!({
      req: { type: "req", id: "native-demand", method: "models.list" },
      params: {
        agentId: "pro",
        view: "all",
        includeDefaultModels: false,
        refresh,
        ...pickerParams,
      },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    return respond;
  };
}

it("keeps headless picker discovery scoped and cached before full demand", async () => {
  const config: OpenClawConfig = {
    gateway: { controlUi: { enabled: false } },
    agents: {
      entries: { pro: {} },
      defaults: { model: "custom/saved-model", modelPolicy: { allow: ["*"] } },
    },
  };
  const native = nativeModel("custom", "native-model", "native-test");
  const otherNative = nativeModel("other", "other-native-model", "native-test");
  const uncredentialed = { provider: "other", id: "hosted-model", name: "Hosted model" };
  const fullOnly = { provider: "outside", id: "full-model", name: "Full model" };
  installHarnesses({ id: "native-test", loadModelCatalog: async () => [native, otherNative] });
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(
    snapshot([saved, uncredentialed, fullOnly]),
  );
  await publish(config);
  const owner = readSnapshot(fixture.agentInput("pro", config))!;
  expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

  await owner.loadNativeModelCatalog!();
  expect(owner.readFullModelCatalog!()?.entries).toContainEqual(expect.objectContaining(native));
  await createPicker(config, { preparedOnly: true })();
  expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

  const scopedPick = createPicker(config, { provider: "other" });
  await scopedPick();
  await vi.waitFor(() =>
    expect(owner.readFullModelCatalog!()?.entries).toContainEqual(
      expect.objectContaining(uncredentialed),
    ),
  );
  await scopedPick();
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledExactlyOnceWith(["other"]);
  expect(owner.readFullModelCatalog!()?.entries).not.toContainEqual(
    expect.objectContaining(fullOnly),
  );

  const pick = createPicker(config);
  await pick();
  await vi.waitFor(() =>
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenLastCalledWith(undefined),
  );
  await vi.waitFor(() =>
    expect(owner.readFullModelCatalog!()?.entries).toContainEqual(
      expect.objectContaining(fullOnly),
    ),
  );
  await pick();
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
});

it("defers native discovery until agent catalog demand and reacquires retired observations", async () => {
  const agentIds = ["default", "pro", "unused"];
  mocks.configuredAgentIds = agentIds;
  const config = nativeConfig(
    "demo/native-model",
    {
      "demo/native-model": { agentRuntime: { id: "native-test" } },
    },
    agentIds,
  );
  const native = nativeModel("demo", "native-model", "native-test");
  mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
  const observed = new Set<string>();
  const loadNative = vi.fn<NonNullable<AgentHarness["loadModelCatalog"]>>(async ({ agentDir }) => {
    observed.add(agentDir);
    return [native];
  });
  installHarnesses({
    id: "native-test",
    authBootstrap: "harness",
    loadModelCatalog: loadNative,
    readModelCatalogReadiness: ({ agentDir }) =>
      observed.has(agentDir) ? { accountType: "apiKey" } : undefined,
  });
  const providerRows = [{ provider: "builtin", id: "known", name: "Known" }];
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(snapshot(providerRows));
  await publish(config);
  for (const agentId of agentIds) {
    await readSnapshot(fixture.agentInput(agentId, config))!.loadFullModelCatalog!({
      changedOnly: true,
    });
  }
  expect(loadNative).not.toHaveBeenCalled();
  const read = () => loadCatalog({ agentId: "pro", config });
  const requestPicker = createPicker(config);
  const pick = async () => {
    expectModels(await requestPicker(), [{ provider: native.provider, id: native.id }]);
  };
  await Promise.all([pick(), pick()]);
  expect(loadNative).toHaveBeenCalledOnce();
  const [first, concurrent] = await Promise.all([read(), read()]);
  expect(first.entries).toContainEqual(expect.objectContaining(native));
  expect(concurrent.entries).toEqual(first.entries);
  expect(loadNative).toHaveBeenCalledOnce();
  expect(observed).toEqual(new Set([fixture.state.agentDir("pro")]));
  observed.clear();
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(2);
  observed.clear();
  loadNative.mockResolvedValueOnce({
    entries: [native],
    outcomes: [{ provider: "demo", status: "unavailable" }],
  });
  await read();
  await read();
  expect(loadNative).toHaveBeenCalledTimes(3);
  await publish(config);
  expect(loadNative).toHaveBeenCalledTimes(3);
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(4);
});

it.each(["discovery failure", "superseded owner", "changed authorization"])(
  "preserves the models.list publication contract after native %s",
  async (outcome) => {
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const failure = new Error("Native model/list unavailable");
    const loadNative = vi.fn(async () => {
      if (outcome === "superseded owner") {
        invalidate();
      } else if (outcome === "changed authorization") {
        invalidateOperatorRolePolicy("synthetic-picker-user");
      }
      throw failure;
    });
    installHarnesses({ id: "native-test", loadModelCatalog: loadNative });
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      snapshot([saved], {
        providerOutcomes: [{ provider: saved.provider, status: "ready" }],
      }),
    );
    const owner = await prepareOwner(config);
    expect(loadNative).not.toHaveBeenCalled();
    const pick = createPicker(config);
    const respond = await pick();
    expect(loadNative).toHaveBeenCalledOnce();
    if (outcome !== "discovery failure") {
      expect(respond.mock.calls).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", retryable: true, retryAfterMs: 0 }),
        ],
      ]);
      return;
    }
    expectModels(respond, [saved], { refreshFailed: true });
    await pick();
    expect(loadNative).toHaveBeenCalledOnce();
    await expect(
      owner.loadNativeModelCatalog!({
        provider: "custom",
        modelId: "native",
        runtime: "native-test",
      }),
    ).rejects.toBe(failure);
    await expect(pick(true)).rejects.toBe(failure);
    expect(loadNative).toHaveBeenCalledTimes(3);
  },
);

it.each([
  { sharedProvider: false, runtime: "native-test" },
  { sharedProvider: true, runtime: "constructor" },
  { sharedProvider: true, runtime: "__proto__" },
])(
  "reacquires a retired $runtime after a sibling failure (shared provider: $sharedProvider)",
  async ({ sharedProvider, runtime }) => {
    const config = nativeConfig("demo/native-model", {
      "demo/native-model": {
        agentRuntime: { id: runtime },
        ...(sharedProvider ? { pickerRuntimes: ["failed-native"] } : {}),
      },
    });
    mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
    const native = nativeModel("demo", "native-model", runtime);
    let healthyReady = false;
    let failedReady = sharedProvider;
    const loadHealthy = vi.fn(async () => {
      healthyReady = true;
      return [native];
    });
    const loadFailed = vi.fn(async () => {
      if (!failedReady) {
        throw new Error("Sibling native discovery unavailable");
      }
      return [{ ...native, nativeRuntime: "failed-native" }];
    });
    installHarnesses(
      ...(
        [
          [runtime, loadHealthy, () => healthyReady],
          ["failed-native", loadFailed, () => failedReady],
        ] as const
      ).map(([id, loadModelCatalog, isReady]) => ({
        id,
        label: id,
        authBootstrap: "harness" as const,
        loadModelCatalog,
        readModelCatalogReadiness: () => (isReady() ? { accountType: "apiKey" } : undefined),
      })),
    );
    await prepareOwner(config);
    const pick = createPicker(config);
    await pick();
    if (sharedProvider) {
      failedReady = false;
      await pick(true);
    }
    const acquisitions = loadHealthy.mock.calls.length;
    const expectHealthy = async () => {
      expectModels(await pick(), [{ id: native.id, available: true }], { refreshFailed: true });
    };
    await expectHealthy();
    expect(loadHealthy).toHaveBeenCalledTimes(acquisitions);
    expect(loadFailed).toHaveBeenCalledTimes(acquisitions);
    healthyReady = false;
    await expectHealthy();
    expect(loadHealthy).toHaveBeenCalledTimes(acquisitions + 1);
    expect(loadFailed).toHaveBeenCalledTimes(acquisitions + 1);
  },
);

it("acquires remaining native runtimes after an initial provider-scoped refresh", async () => {
  const config = nativeConfig("first/native-model", {
    "first/native-model": { agentRuntime: { id: "native-first" } },
    "second/configured-hint": { pickerRuntimes: ["native-second"] },
  });
  mocks.resolveNativeModelPrimary.mockReturnValue("first/native-model");
  const first = nativeModel("first", "native-model", "native-first", "First");
  const second = nativeModel("second", "discovered-model", "native-second", "Second");
  const loadFirst = vi.fn(async () => [first]);
  const loadSecond = vi.fn(async () => [second]);
  installHarnesses(
    ...(
      [
        [first, loadFirst],
        [second, loadSecond],
      ] as const
    ).map(([entry, loadModelCatalog]) => ({
      id: entry.nativeRuntime,
      label: entry.name,
      authBootstrap: "harness" as const,
      loadModelCatalog,
    })),
  );
  await prepareOwner(config, { providerIds: ["first"], refresh: true, wait: true });
  expect(loadSecond).not.toHaveBeenCalled();
  const respond = await createPicker(config)();
  expect(loadSecond).toHaveBeenCalledOnce();
  expectModels(respond, [{ provider: second.provider, id: second.id }]);
});

it("lets settled and uncalled plugins reload while another native lookup is hung (#199521)", async () => {
  const config = nativeConfig("fast/native-model", {
    "fast/native-model": { agentRuntime: { id: "native-fast" } },
  });
  mocks.resolveNativeModelPrimary.mockReturnValue("fast/native-model");
  const registry = createEmptyPluginRegistry();
  const [fastPlugin, failPlugin, hangPlugin, sibling] = [
    "native-fast",
    "native-fail",
    "native-hang",
    "sibling-provider",
  ].map((id) => {
    const record = createPluginRecord({ id, status: "loaded" });
    registry.plugins.push(record);
    return createTestInstance(id, { record, registry });
  });
  const started = createDeferredCore();
  const hung = createDeferredCore<never[]>();
  // Discovery runs these in order: one returns, one throws, and the last stays pending.
  const harnesses = [
    { id: "native-fast", plugin: fastPlugin!, load: async () => [] },
    {
      id: "native-fail",
      plugin: failPlugin!,
      load: async () => {
        throw new Error("synthetic native catalog failure");
      },
    },
    {
      id: "native-hang",
      plugin: hangPlugin!,
      load: () => {
        started.resolve();
        return hung.promise;
      },
    },
  ];
  for (const { id, plugin, load } of harnesses) {
    registry.agentHarnesses.push(
      ...harnessRegistry(id, { loadModelCatalog: plugin.wrap(load) }).agentHarnesses,
    );
  }
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(snapshot([saved]));
  const owner = await prepareOwner(config);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const served = owner.loadNativeModelCatalog!();
    await started.promise;
    // Plugins whose callbacks settled, and a plugin the lookup never called, hold nothing.
    for (const plugin of [fastPlugin!, failPlugin!, sibling!]) {
      expect(plugin.retainedWorkCount).toBe(0);
      expect(plugin.ordinaryCallCount).toBe(0);
      const releaseReservation = plugin.reserveReplacement();
      await plugin.waitForIdle(new AbortController().signal);
      releaseReservation();
    }
    // The hung harness keeps its own plugin through its running call, attributed to discovery.
    expect(hangPlugin!.retainedWorkCount).toBe(0);
    expect(hangPlugin!.ordinaryCallCount).toBe(1);
    expect(hangPlugin!.retentionSnapshot().references).toContainEqual(
      expect.objectContaining({
        kind: "call",
        owner: { agentId: "pro", serviceId: "model-catalog-discovery" },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await served).entries).toContainEqual(expect.objectContaining(saved));
    hung.resolve([]);
    await vi.waitFor(() => expect(hangPlugin!.ordinaryCallCount).toBe(0));
  } finally {
    hung.resolve([]);
    vi.useRealTimers();
  }
});

describe("native selection authority", () => {
  function setProviderCatalog(
    entries: ModelCatalogEntry[],
    providerOutcomes?: ModelCatalogSnapshot["providerOutcomes"],
  ) {
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries,
      routeVariants: [...entries],
      ...(providerOutcomes ? { providerOutcomes } : {}),
    });
  }
  function expectCatalogModels(
    actual: readonly ModelCatalogEntry[] | undefined,
    ...expected: Partial<ModelCatalogEntry>[]
  ) {
    for (const model of expected) {
      expect(actual).toContainEqual(expect.objectContaining(model));
    }
  }

  function expectMissing(entries: readonly ModelCatalogEntry[], model: Partial<ModelCatalogEntry>) {
    expect(entries).not.toContainEqual(expect.objectContaining(model));
  }
  function holdDiscovery<T>(result: () => T) {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    return {
      entered: entered.promise,
      release: release.resolve,
      load: async () => {
        entered.resolve();
        await release.promise;
        return result();
      },
    };
  }
  function nativeSelection(
    entry: Pick<ModelCatalogEntry, "provider" | "id"> & { nativeRuntime: string },
    modelId = entry.id,
  ) {
    return { provider: entry.provider, modelId, runtime: entry.nativeRuntime };
  }

  async function renewProvider(owner: PreparedModelRuntimeSnapshot, provider: string) {
    const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
    inventory.providers.get(provider)!.expiresAt = 0;
    const published = createDeferredCore();
    const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-published") {
        published.resolve();
      }
    });
    try {
      owner.refreshExpiredModelCatalog!();
      await published.promise;
    } finally {
      unsubscribe();
    }
  }
  async function pickerFixture(standalone = false, cold = false, runtimeA = "native-a") {
    const { resolveNativeModelPrimary } =
      await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    mocks.resolveNativeModelPrimary.mockImplementation(resolveNativeModelPrimary);
    const a = { provider: "provider-a", id: "model", name: "A", nativeRuntime: runtimeA };
    const b = { provider: "provider-b", id: "model", name: "B", nativeRuntime: "native-b" };
    const loadA = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [a]);
    const loadB = vi.fn<() => Promise<AgentHarnessModelCatalogResult>>(async () => [b]);
    installHarnesses(
      { id: a.nativeRuntime, loadModelCatalog: loadA },
      { id: b.nativeRuntime, loadModelCatalog: loadB },
    );
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const input = {
      config,
      agentId: "pro",
      agentDir: fixture.state.agentDir("pro"),
      allowGatewaySubagentBinding: true,
    };
    mocks.configuredAgentIds = ["pro"];
    setProviderCatalog([]);
    if (!standalone) {
      // Gateway commits start background discovery. Publish the cold owner separately after activation.
      if (cold) {
        mocks.configuredAgentIds = [];
      }
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
      mocks.configuredAgentIds = ["pro"];
    }
    const owner =
      standalone || cold
        ? await publishPreparedModelRuntimeSnapshot(input, {
            catalogMode: "static",
            provenance: standalone ? "standalone" : "configured",
          })
        : readSnapshot(input)!;
    if (!standalone && !cold) {
      await owner.loadFullModelCatalog!();
    }
    return { input, owner, a, b, loadA, loadB };
  }
  async function resolveNativeSelection(
    input: PreparedModelRuntimeInput,
    lease: PreparedModelRuntimeLease,
    selected: { provider: string; id: string; nativeRuntime: string },
    assertCurrent = () => {},
  ) {
    const workspaceDir = lease.snapshot.workspaceDir!;
    const preparedModelRuntime = Object.freeze({
      ...lease.snapshot,
      repoRoot: workspaceDir,
      projectKey: "native-selection-project",
      activeProjectKeys: ["native-selection-project"],
    });
    return await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
      resolveEmbeddedRunModelSetup({
        assertCurrent,
        runParams: {
          config: input.config,
          agentId: input.agentId,
          sessionId: "cold",
          runId: "cold",
          workspaceDir,
          prompt: "Use the saved native choice",
          timeoutMs: 30000,
          agentHarnessRuntimeOverride: selected.nativeRuntime,
        },
        provider: selected.provider,
        modelId: selected.id,
        agentDir: input.agentDir,
        workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "cold", workspaceDir },
        onHooksResolved: () => {},
        preparedModelRuntime,
      }),
    );
  }
  it("keeps native selection bound to its admitted lease when run authority is revoked", async () => {
    const { input, owner, b, loadB } = await pickerFixture(false, true);
    await using lease = await acquirePreparedModelRuntimeSnapshot(input);
    let leaseOpen = true;
    let runCurrent = true;
    const discovery = holdDiscovery(() => [b]);
    loadB.mockImplementation(discovery.load);
    let setup: ReturnType<typeof resolveNativeSelection> | undefined;
    try {
      setup = withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        () =>
          resolveNativeSelection(input, lease, b, () => {
            if (!runCurrent) {
              throw new Error("Native selection run authority revoked");
            }
          }),
        () => (leaseOpen ? lease.snapshot : undefined),
      );
      await Promise.race([
        discovery.entered,
        setup.then(() => {
          throw new Error("Native model setup completed before selected discovery");
        }),
      ]);
      runCurrent = false;
      discovery.release();
      await expect(setup).rejects.toThrow("Native selection run authority revoked");
    } finally {
      discovery.release();
      await Promise.allSettled([setup]);
      leaseOpen = false;
    }
  });
  it("preserves native auth rejection through provider renewals without a refresh error (constructor)", async () => {
    const runtimeA = "constructor";
    const { owner, a, b, loadA, loadB } = await pickerFixture(true, false, runtimeA);
    const api = { provider: "api-provider", id: "model", name: "API model" };
    setProviderCatalog([api], [{ provider: api.provider, status: "ready" }]);
    loadB.mockResolvedValue({
      entries: [b],
      outcomes: [{ provider: b.provider, status: "ready" }],
    });
    await owner.loadFullModelCatalog!({ refresh: true });
    await owner.loadFullModelCatalog!({ refresh: true, providerIds: [a.provider] });
    const failure = {
      provider: a.provider,
      status: "auth-rejected",
      rejectionScope: "catalog",
    } as const;
    const updatedB = { ...b, name: "Updated native B" };
    loadA.mockResolvedValue({
      entries: [],
      outcomes: [{ ...failure, provider: ` ${a.provider.toUpperCase()} ` }],
    });
    loadB.mockResolvedValue({
      entries: [updatedB],
      outcomes: [{ provider: b.provider, status: "ready" }],
    });
    const partial = await owner.loadFullModelCatalog!({ refresh: true });
    expect(partial.authoritative).toBe(false);
    expect(partial.refreshFailed).toBeUndefined();
    expect(partial.providerOutcomes).toContainEqual(failure);
    expectCatalogModels(partial.entries, a, updatedB);

    const nativeCalls = loadA.mock.calls.length;
    await renewProvider(owner, api.provider);
    const renewed = owner.readFullModelCatalog!()!;
    expect(loadA).toHaveBeenCalledTimes(nativeCalls);
    expect(renewed.authoritative).toBe(false);
    expect(renewed.refreshFailed).toBeUndefined();
    expect(renewed.providerOutcomes).toContainEqual(failure);
    expectCatalogModels(renewed.entries, updatedB);

    // An empty successful result also represents disabled or missing optional apps.
    loadA.mockResolvedValue({ entries: [] });
    const cleared = await owner.loadFullModelCatalog!({ refresh: true });
    expect(cleared.refreshFailed).toBeUndefined();
    expect(cleared.providerOutcomes?.some(({ provider }) => provider === a.provider)).toBe(false);
    expectMissing(cleared.entries, { provider: a.provider });
    expectCatalogModels(cleared.entries, updatedB);
  });
  it("keeps API provider readiness independent of a failed native runtime for the same provider", async () => {
    const { owner, a, loadA } = await pickerFixture(true);
    const api = { provider: a.provider, id: "api-model", name: "API model" };
    const ready = { provider: a.provider, status: "ready" } as const;
    setProviderCatalog([api], [ready]);
    loadA.mockResolvedValue({
      entries: [],
      outcomes: [{ provider: a.provider, status: "unavailable", rejectionScope: "catalog" }],
    });
    const partial = await owner.loadFullModelCatalog!({ refresh: true });
    expect(partial.refreshFailed).toBe(true);
    expect(partial.providerOutcomes?.filter(({ provider }) => provider === a.provider)).toEqual([
      ready,
    ]);
    expectCatalogModels(partial.entries, api);
    loadA.mockResolvedValue({ entries: [] });
    const recovered = await owner.loadFullModelCatalog!({ refresh: true });
    expect(recovered.refreshFailed).toBeUndefined();
    expect(recovered.providerOutcomes?.filter(({ provider }) => provider === a.provider)).toEqual([
      ready,
    ]);
  });
  it("rejects native readiness that retires its owner after queue", async () => {
    const { owner, b, loadB } = await pickerFixture(true, true);
    await owner.loadFullModelCatalog!({ refresh: true });
    const calls = loadB.mock.calls.length;
    const readReadiness = vi.fn(() => {
      invalidate();
      return { accountType: "native" };
    });
    const nativeHarness = owner.pluginRegistry!.agentHarnesses.find(
      (registration) => registration.harness.id === b.nativeRuntime,
    )!.harness;
    nativeHarness.readModelCatalogReadiness = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementation(readReadiness);
    await expect(owner.loadNativeModelCatalog!(nativeSelection(b))).rejects.toThrow("superseded");
    expect(owner.isCurrent()).toBe(false);
    expect(loadB).toHaveBeenCalledTimes(calls);
  });
});
