import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
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
import { attachModelProviderRequestRouteFacts } from "../provider-request-config.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";

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
      configuredCatalogEntries: [],
    },
    {
      templateModelRegistry: stores.modelRegistry,
      modelCatalog,
      configuredRuntimeModels: rows,
      inlineProviderModels: [],
    },
    {
      isCurrent: () => true,
      withRefreshStatus: (catalog) => catalog,
      readFullModelCatalog: () => undefined,
      readPublishedModels: () => undefined,
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
  const expected = (modelId: string, maxSidePx?: number) => {
    const model = stores.modelRegistry.find(PROVIDER, modelId);
    if (!model) {
      throw new Error("Missing registered fixture model");
    }
    return attachModelProviderRequestRouteFacts(
      {
        ...model,
        maxTokensSource: "discovered",
        headers: undefined,
        toolSearchMode: undefined,
        compat: {
          supportsDeveloperRole: false,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
        },
        ...(maxSidePx === undefined ? {} : { mediaInput: { image: { maxSidePx } } }),
      },
      stores.modelRegistry.getProviderMetadataOwners(),
    );
  };
  return { snapshot, stores, resolve, expected };
}

describe("prepared configured model indexes", () => {
  it.each([
    { kind: "exact-hit", modelId: "selected", maxSidePx: 1000 },
    { kind: "missing", modelId: "unconfigured", maxSidePx: undefined },
  ])(
    "does not revisit 1000 configured rows during 1000 real $kind resolutions",
    async ({ modelId, maxSidePx }) => {
      await withOpenClawTestState({ label: "configured-model-index" }, async (state) => {
        const rows = Array.from({ length: 1000 }, (_, index) =>
          configuredRow(index === 999 ? "selected" : `model-${index}`, index + 1),
        );
        const before = structuredClone(rows);
        const { snapshot, stores, resolve, expected } = fixture(state, rows, metadata(), [modelId]);
        const descriptor = Object.getOwnPropertyDescriptor(rows, "find");
        const find = rows.find;
        let visits = 0;
        Object.defineProperty(rows, "find", {
          configurable: true,
          value(
            predicate: (
              row: PreparedConfiguredRuntimeModel,
              index: number,
              rows: PreparedConfiguredRuntimeModel[],
            ) => unknown,
            thisArg?: unknown,
          ) {
            return find.call(rows, (row, index, array) => {
              visits += 1;
              return predicate.call(thisArg, row, index, array);
            });
          },
        });
        const resolved = [];
        try {
          for (let index = 0; index < 1000; index += 1) {
            resolved.push(await resolve(modelId));
          }
        } finally {
          if (descriptor) {
            Object.defineProperty(rows, "find", descriptor);
          } else {
            Reflect.deleteProperty(rows, "find");
          }
        }
        expect(resolved).toEqual(
          Array.from({ length: 1000 }, () => ({
            ...stores,
            model: expected(modelId, maxSidePx),
            logicalRef: { provider: PROVIDER, model: modelId },
          })),
        );
        expect(snapshot.configuredRuntimeModels).toBe(rows);
        expect(rows).toEqual(before);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(visits).toBe(0);
      });
    },
  );

  it.each([
    { modelId: "selected", maxSidePx: 1100 },
    { modelId: "SELECTED", maxSidePx: 2200 },
    { modelId: "  selected  ", maxSidePx: 2200 },
  ])(
    "preserves exact-first and first-equivalent precedence for $modelId",
    async ({ modelId, maxSidePx }) => {
      await withOpenClawTestState({ label: "configured-model-precedence" }, async (state) => {
        const rows = [
          configuredRow("selected", 4400, "other-provider"),
          configuredRow("alias", 2200),
          configuredRow("selected", 1100, PROVIDER.toUpperCase()),
          configuredRow("selected", 3300),
        ];
        const before = structuredClone(rows);
        const { resolve, expected, stores } = fixture(
          state,
          rows,
          metadata({ alias: "selected" }),
          [modelId],
        );
        const result = await resolve(modelId);
        expect(result).toEqual({
          ...stores,
          model: expected(modelId, maxSidePx),
          logicalRef: { provider: PROVIDER, model: modelId },
        });
        expect(rows).toEqual(before);
      });
    },
  );

  it("retains old policy indexes through projections while new snapshots use new policies", async () => {
    await withOpenClawTestState({ label: "configured-model-generation" }, async (state) => {
      const rows = [configuredRow("first", 1100), configuredRow("second", 2200)];
      const oldMetadata = metadata({ selected: "first" });
      const newMetadata = metadata({ selected: "second" });
      const old = fixture(state, rows, oldMetadata);
      const current = fixture(state, rows, newMetadata);
      const projected = { ...old.snapshot, activeProjectKeys: ["fixture-project"] };
      await withPluginRuntimeGenerationScope({ metadataSnapshot: newMetadata }, async () => {
        expect((await old.resolve("selected")).model).toEqual(old.expected("selected", 1100));
        expect((await old.resolve("selected", projected)).model).toEqual(
          old.expected("selected", 1100),
        );
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot: oldMetadata }, async () => {
        expect((await current.resolve("selected")).model).toEqual(
          current.expected("selected", 2200),
        );
      });
      expect(old.snapshot.configuredRuntimeModels).toBe(rows);
      expect(current.snapshot.configuredRuntimeModels).toBe(rows);
      expect(projected.metadataSnapshot).toBe(oldMetadata);
    });
  });
});
