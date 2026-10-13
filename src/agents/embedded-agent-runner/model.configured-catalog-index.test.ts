import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.types.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import { makeModel } from "./model.test-harness.js";

const PROVIDER = "configured-index-fixture";
const BASE_URL = "https://configured-index.example.invalid/v1";

function configuredRow(modelId: string, maxSidePx: number, provider = PROVIDER) {
  return {
    provider,
    modelId,
    model: {
      ...makeProviderModelFixture({
        provider: "wire-provider",
        id: `wire-${modelId}`,
        api: "openai-completions",
        baseUrl: BASE_URL,
      }),
      mediaInput: { image: { maxSidePx } },
    },
  } satisfies PreparedConfiguredRuntimeModel;
}

function metadata(aliases: Record<string, string> = {}) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: PROVIDER,
        providers: [PROVIDER],
        modelIdNormalization: { providers: { [PROVIDER]: { aliases } } },
      },
    ],
  });
}

function fixture(
  state: OpenClawTestState,
  rows: PreparedConfiguredRuntimeModel[],
  metadataSnapshot: PluginMetadataSnapshot,
  modelIds = ["selected"],
) {
  const config = {};
  const stores = createEmptyAgentDiscoveryStores();
  stores.modelRegistry.registerProvider(PROVIDER, {
    api: "openai-completions",
    baseUrl: BASE_URL,
    models: modelIds.map((id) => ({
      ...makeProviderModelFixture({
        provider: PROVIDER,
        id,
        api: "openai-completions",
        baseUrl: BASE_URL,
      }),
      contextWindow: 16_000,
    })),
  });
  const authStore = { version: 1 as const, profiles: {} };
  const modelCatalog = { entries: [], routeVariants: [] };
  const snapshot = createPreparedModelRuntimeSnapshot(
    undefined,
    {
      input: { config, agentDir: state.agentDir(), workspaceDir: state.workspaceDir },
      env: state.env,
      authStore,
      templateAuthStorage: stores.authStorage,
      credentials: {},
      providerIds: [],
      configuredModelRefs: rows.map(({ provider, modelId }) => ({ provider, modelId })),
      configuredRuntimeModels: rows,
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
    },
    {
      pluginMetadataSnapshot: metadataSnapshot,
      inlineProviderModels: [],
      remoteCatalog: null,
      configuredCatalogEntries: [],
    },
    {
      templateModelRegistry: stores.modelRegistry,
      modelCatalog,
      configuredRuntimeModels: rows,
      inlineProviderModels: [],
    },
    {
      initialAuth: { authStore, authModes: {}, providerAuthLabels: new Map() },
      isCurrent: () => true,
      withRefreshStatus: (catalog) => catalog,
      readFullModelCatalog: () => undefined,
      readPublishedModels: () => undefined,
      refreshExpiredModelCatalog: () => {},
      recheckNativeLogin: () => {},
      loadNativeModelCatalog: async () => {
        throw new Error("Configured index lookups must not discover native models");
      },
      loadFullModelCatalog: async () => modelCatalog,
      loadAuth: async () => ({ authStore, authModes: {} }),
    },
  );
  const resolve = (
    modelId: string,
    preparedModelRuntime: PreparedModelRuntimeSnapshot = snapshot,
  ) =>
    resolveModelAsync(PROVIDER, modelId, state.agentDir(), config, {
      ...stores,
      preparedModelRuntime,
      modelIdSource: "selected",
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
      allowBundledStaticCatalogFallback: true,
    });
  return { snapshot, resolve };
}

describe("prepared configured model indexes", () => {
  it("resolves indexed misses without rescanning", async () => {
    const modelId = "unconfigured";
    await withOpenClawTestState({ label: "configured-model-precedence" }, async (state) => {
      const rows = [
        configuredRow("selected", 4400, "other-provider"),
        configuredRow("alias", 2200),
        configuredRow("selected", 1100, PROVIDER.toUpperCase()),
        configuredRow("selected", 3300),
      ];
      const before = structuredClone(rows);
      const { resolve, snapshot } = fixture(state, rows, metadata({ alias: "selected" }), [
        modelId,
      ]);
      Object.defineProperty(rows, "find", {
        configurable: true,
        value() {
          throw new Error("Configured models must be indexed before resolution");
        },
      });
      try {
        const result = await resolve(modelId);
        expect(result.error).toBeUndefined();
        expect(result).toMatchObject({
          model: { provider: PROVIDER, id: modelId },
          logicalRef: { provider: PROVIDER, model: modelId },
        });
        expect(result.model).not.toHaveProperty("mediaInput");
      } finally {
        Reflect.deleteProperty(rows, "find");
      }
      expect(rows).toEqual(before);
      expect(snapshot.configuredRuntimeModels).toBe(rows);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });
  });

  it("retains old policy indexes through projections while new snapshots use new policies", async () => {
    await withOpenClawTestState({ label: "configured-model-generation" }, async (state) => {
      const rows = [configuredRow("first", 1100), configuredRow("second", 2200)];
      const oldMetadata = metadata({ selected: "first" });
      const newMetadata = metadata({ selected: "second" });
      const old = fixture(state, rows, oldMetadata);
      const current = fixture(state, rows, newMetadata);
      const projected = { ...old.snapshot, activeProjectKeys: ["fixture-project"] };
      await withPluginRuntimeGenerationScope({ metadataSnapshot: newMetadata }, async () => {
        expect((await old.resolve("selected")).model).toMatchObject({
          mediaInput: { image: { maxSidePx: 1100 } },
        });
        expect((await old.resolve("selected", projected)).model).toMatchObject({
          mediaInput: { image: { maxSidePx: 1100 } },
        });
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot: oldMetadata }, async () => {
        expect((await current.resolve("selected")).model).toMatchObject({
          mediaInput: { image: { maxSidePx: 2200 } },
        });
      });
      expect(old.snapshot.configuredRuntimeModels).toBe(rows);
      expect(current.snapshot.configuredRuntimeModels).toBe(rows);
      expect(projected.metadataSnapshot).toBe(oldMetadata);
    });
  });
});

describe("selected model materialization", () => {
  const provider = "selected-model-test";
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: provider,
        providers: [provider],
        modelIdNormalization: {
          providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
        },
      },
    ],
  });

  function createResolutionOptions() {
    const stores = createEmptyAgentDiscoveryStores();
    stores.modelRegistry.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://selected-model.example/v1",
      models: ["middle", "final"].map((id) =>
        Object.assign(
          makeProviderModelFixture({
            provider,
            id,
            api: "openai-completions",
            baseUrl: "https://selected-model.example/v1",
          }),
          { contextWindow: 16_000, maxTokens: 4_096 },
        ),
      ),
    });
    return { ...stores, skipAgentDiscovery: true, skipProviderRuntimeHooks: true };
  }

  it.each(["credential", "route"] as const)(
    "preserves the selected executable ID during %s materialization",
    async (mode) => {
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const options = createResolutionOptions();
        const selected = await resolveModelAsync(provider, "entry", undefined, {}, options);
        expect(selected.model?.id).toBe("middle");
        const model = await materializePreparedRuntimeModel({
          plan: {
            providerForAuth: provider,
            authProfileProviderForAuth: provider,
            selectedAuthMode: "api-key",
            ...(mode === "route"
              ? {
                  modelRoute: {
                    provider,
                    modelId: "middle",
                    api: "openai-completions" as const,
                    baseUrl: "https://selected-model.example/v1",
                    authRequirement: "api-key" as const,
                    requestTransportOverrides: "none" as const,
                  },
                }
              : {}),
          },
          provider,
          modelId: "middle",
          model: selected.model,
          metadataSnapshot,
          forceResolve: true,
          resolveModel: () =>
            resolveModelAsync(
              provider,
              "middle",
              undefined,
              {},
              {
                ...options,
                modelIdSource: "selected",
              },
            ),
        });
        expect(model?.id).toBe("middle");
      });
    },
  );
});

describe("configured model discovery facts", () => {
  it.each([
    { configuredContext: undefined, supportsTools: false },
    { configuredContext: undefined, supportsTools: true },
    { configuredContext: 16_384, supportsTools: false },
  ])(
    "inherits admitted facts with context pin $configuredContext and tools $supportsTools",
    async ({ configuredContext, supportsTools }) => {
      const provider = "router-fixture";
      const modelId = "unloaded-at-setup";
      const baseUrl = "http://127.0.0.1:19288/v1";
      const config: OpenClawConfig = {
        models: {
          providers: {
            [provider]: {
              api: "openai-completions",
              baseUrl,
              models: [
                {
                  ...makeModel(modelId),
                  contextWindow: configuredContext,
                  contextTokens: configuredContext,
                },
              ],
            },
          },
        },
      };
      const stores = createEmptyAgentDiscoveryStores();
      const catalogModel = {
        ...makeProviderModelFixture({
          provider,
          id: modelId,
          api: "openai-completions",
          baseUrl,
        }),
        contextWindow: 32_768,
        contextTokens: 32_768,
        compat: { supportsTools, supportsUsageInStreaming: true },
      } satisfies ProviderRuntimeModel;
      stores.modelRegistry.registerProvider(provider, {
        api: "openai-completions",
        baseUrl,
        models: [catalogModel],
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot: metadata() }, async () => {
        const result = await resolveModelAsync(provider, modelId, undefined, config, {
          ...stores,
          skipAgentDiscovery: true,
          skipProviderRuntimeHooks: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.model).toMatchObject({
          contextWindow: configuredContext ?? 32_768,
          contextTokens: configuredContext ?? 32_768,
          compat: { supportsTools },
          api: "openai-completions",
          baseUrl,
        });
      });
    },
  );
});
