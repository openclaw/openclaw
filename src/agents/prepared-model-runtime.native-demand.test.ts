// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AgentHarness } from "./harness/types.js";
import { harnessRegistry, snapshot } from "./model-catalog-fixtures.test-support.js";
import { loadPreparedModelCatalogSnapshot as loadCatalog } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeSnapshot as readSnapshot,
  markPreparedModelRuntimeSnapshotsStale as invalidate,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
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

it("serves published models while single-flight native discovery is pending", async ({
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
  const loadNative = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return [discovered];
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
  const requests = Array.from({ length: 3 }, () => pick());
  try {
    await withinTest(started.promise, signal);
    for (const response of await withinTest(Promise.all(requests), signal)) {
      expectModels(response, [saved]);
    }
    expect(loadNative).toHaveBeenCalledOnce();
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
  pickerParams: { sessionKey?: string; view?: "all" | "configured" } = {},
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
  await read();
  expect(loadNative).toHaveBeenCalledOnce();
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
    expect(owner.readFullModelCatalog!()?.entries).toContainEqual(expect.objectContaining(saved));
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
  expect(loadFirst).toHaveBeenCalledOnce();
  expect(loadSecond).not.toHaveBeenCalled();
  const respond = await createPicker(config)();
  expect(loadSecond).toHaveBeenCalledOnce();
  expectModels(respond, [{ provider: second.provider, id: second.id }]);
});
