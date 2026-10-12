// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
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
import type {
  AgentHarnessModelCatalogParams,
  AgentHarnessModelCatalogResult,
} from "./harness/types.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "native-demand" });
const { mocks } = fixture;

function createPicker(config: OpenClawConfig) {
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
      params: { agentId: "pro", view: "all", includeDefaultModels: false, refresh },
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
  const config: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: {
        model: "demo/native-model",
        models: { "demo/native-model": { agentRuntime: { id: "native-test" } } },
      },
    },
  };
  const native = {
    provider: "demo",
    id: "native-model",
    name: "Native model",
    nativeRuntime: "native-test",
  };
  mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
  const observed = new Set<string>();
  const loadNative = vi.fn<
    (params: AgentHarnessModelCatalogParams) => Promise<AgentHarnessModelCatalogResult>
  >(async ({ agentDir }) => {
    observed.add(agentDir);
    return [native];
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-test",
      source: "fixture",
      harness: {
        id: "native-test",
        label: "Native test",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog: loadNative,
        readModelCatalogReadiness: ({ agentDir }) =>
          observed.has(agentDir) ? { accountType: "apiKey" } : undefined,
      },
    });
    return registry;
  });
  const providerRows = [{ provider: "builtin", id: "known", name: "Known" }];
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: providerRows,
    routeVariants: providerRows,
  });
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  for (const agentId of agentIds) {
    await getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, config))!
      .loadFullModelCatalog!({
      changedOnly: true,
    });
  }
  expect(loadNative).not.toHaveBeenCalled();
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(agentIds.length);
  const read = () =>
    loadPreparedModelCatalogSnapshot({
      agentId: "pro",
      config,
    });
  const requestPicker = createPicker(config);
  const pick = async () => {
    const respond = await requestPicker();
    const [ok, result, error] = respond.mock.calls[0] ?? [];
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: native.provider, id: native.id }),
      ]),
    });
  };
  await Promise.all([pick(), pick()]);
  expect(loadNative).toHaveBeenCalledOnce();
  const [first, concurrent] = await Promise.all([read(), read()]);
  expect(first.entries).toContainEqual(expect.objectContaining(native));
  expect(concurrent.entries).toEqual(first.entries);
  expect(loadNative).toHaveBeenCalledOnce();
  expect(loadNative.mock.calls[0]?.[0].agentDir).toBe(fixture.state.agentDir("pro"));
  await read();
  expect(loadNative).toHaveBeenCalledOnce();
  observed.clear();
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(2);
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(agentIds.length);
  observed.clear();
  loadNative.mockResolvedValueOnce({
    entries: [native],
    outcomes: [{ provider: "demo", status: "unavailable" }],
  });
  await read();
  await read();
  expect(loadNative).toHaveBeenCalledTimes(3);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  expect(loadNative).toHaveBeenCalledTimes(3);
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(4);
});

it.each(["discovery failure", "superseded owner", "changed authorization"])(
  "preserves the models.list publication contract after native %s",
  async (outcome) => {
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    mocks.configuredAgentIds = ["pro"];
    const failure = new Error("Native model/list unavailable");
    const loadNative = vi.fn(async () => {
      if (outcome === "superseded owner") {
        markPreparedModelRuntimeSnapshotsStale();
      } else if (outcome === "changed authorization") {
        invalidateOperatorRolePolicy("synthetic-picker-user");
      }
      throw failure;
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "native-test",
        source: "fixture",
        harness: {
          id: "native-test",
          label: "Native test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog: loadNative,
        },
      });
      return registry;
    });
    const saved = { provider: "custom", id: "saved-model", name: "Saved model" };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [saved],
      routeVariants: [saved],
      providerOutcomes: [{ provider: saved.provider, status: "ready" }],
    });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const owner = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config))!;
    await owner.loadFullModelCatalog!({ changedOnly: true });
    expect(owner.readFullModelCatalog!()?.entries).toContainEqual(expect.objectContaining(saved));
    expect(loadNative).not.toHaveBeenCalled();
    const pick = createPicker(config);
    const respond = await pick();
    expect(loadNative).toHaveBeenCalledOnce();
    if (outcome !== "discovery failure") {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining(
            outcome === "superseded owner" ? "superseded" : "access changed",
          ),
        }),
      );
      return;
    }
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({
        models: expect.arrayContaining([expect.objectContaining(saved)]),
        refreshFailed: true,
      }),
      undefined,
    );
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
  { sharedProvider: true, runtime: "native-test" },
  { sharedProvider: true, runtime: "constructor" },
  { sharedProvider: true, runtime: "__proto__" },
])(
  "reacquires a retired $runtime after a sibling failure (shared provider: $sharedProvider)",
  async ({ sharedProvider, runtime }) => {
    const config: OpenClawConfig = {
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "demo/native-model",
          models: {
            "demo/native-model": {
              agentRuntime: { id: runtime },
              ...(sharedProvider ? { pickerRuntimes: ["failed-native"] } : {}),
            },
          },
        },
      },
    };
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
    const native = {
      provider: "demo",
      id: "native-model",
      name: "Native model",
      nativeRuntime: runtime,
    };
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
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog, isReady] of [
        [runtime, loadHealthy, () => healthyReady],
        ["failed-native", loadFailed, () => failedReady],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "fixture",
          harness: {
            id,
            label: id,
            authBootstrap: "harness",
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            loadModelCatalog,
            readModelCatalogReadiness: () => (isReady() ? { accountType: "apiKey" } : undefined),
          },
        });
      }
      return registry;
    });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const owner = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config))!;
    await owner.loadFullModelCatalog!({ changedOnly: true });
    const pick = createPicker(config);
    await pick();
    if (sharedProvider) {
      failedReady = false;
      await pick(true);
    }
    const acquisitions = loadHealthy.mock.calls.length;
    const expectHealthy = async () => {
      expect(await pick()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: expect.arrayContaining([
            expect.objectContaining({ id: native.id, available: true }),
          ]),
          refreshFailed: true,
        }),
        undefined,
      );
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
  const config: OpenClawConfig = {
    agents: {
      entries: { pro: {} },
      defaults: {
        model: "first/native-model",
        models: {
          "first/native-model": { agentRuntime: { id: "native-first" } },
          "second/configured-hint": { pickerRuntimes: ["native-second"] },
        },
      },
    },
  };
  mocks.configuredAgentIds = ["pro"];
  mocks.resolveNativeModelPrimary.mockReturnValue("first/native-model");
  const first = {
    provider: "first",
    id: "native-model",
    name: "First",
    nativeRuntime: "native-first",
  };
  const second = {
    provider: "second",
    id: "discovered-model",
    name: "Second",
    nativeRuntime: "native-second",
  };
  const loadFirst = vi.fn(async () => [first]);
  const loadSecond = vi.fn(async () => [second]);
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    for (const [row, loadModelCatalog] of [
      [first, loadFirst],
      [second, loadSecond],
    ] as const) {
      registry.agentHarnesses.push({
        pluginId: row.nativeRuntime,
        source: "fixture",
        harness: {
          id: row.nativeRuntime,
          label: row.name,
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog,
        },
      });
    }
    return registry;
  });
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const owner = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config))!;
  await owner.loadFullModelCatalog!({ providerIds: ["first"], refresh: true, wait: true });
  expect(loadFirst).toHaveBeenCalledOnce();
  expect(loadSecond).not.toHaveBeenCalled();
  const respond = await createPicker(config)();
  expect(loadSecond).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    expect.objectContaining({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: second.provider, id: second.id }),
      ]),
    }),
    undefined,
  );
});
