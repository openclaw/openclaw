import { afterEach, assert, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { planOpenClawModelsJsonSource } from "./models-config.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";

afterEach(clearRuntimeConfigSnapshot);

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const rates = { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 };
const scopedRates = { input: 33, output: 44, cacheRead: 5, cacheWrite: 6 };
type Cost = ModelDefinitionConfig["cost"];

function model(id: string, input: Array<"text" | "image"> = ["text"]) {
  return modelDefinition(id, {
    reasoning: false,
    input,
    contextWindow: 1024,
    maxTokens: 1024,
  });
}

function configFor<T>(providerId: string, provider: T, mode?: "merge" | "replace") {
  return { models: { ...(mode ? { mode } : {}), providers: { [providerId]: provider } } };
}

function discoveryOptions(providerId: string, discovered: ProviderConfig) {
  const provider: ProviderPlugin = {
    id: providerId,
    pluginId: providerId,
    label: "Catalog fixture",
    auth: [],
    staticCatalog: { run: async () => ({ provider: discovered }) },
  };
  const entry = { provider, providerConfigs: { [providerId]: discovered } };
  return {
    preparedStaticProviderCatalog: {
      providers: [provider],
      entries: [entry],
    },
    providerDiscoveryEntriesOnly: true,
    providerDiscoveryProviderIds: [providerId],
  };
}

async function planWrite(params: Parameters<typeof planModelsJsonForTest>[0]) {
  const plan = await planModelsJsonForTest(params);
  assert(plan.action === "write", "Expected catalog write plan");
  return plan;
}

it.each(["merge", "replace"] as const)(
  "keeps one-step identities and exact source fields through repeated %s planning",
  async (mode) => {
    const providerId = "custom";
    const connection = {
      baseUrl: "https://catalog-fields.example/v1",
      api: "openai-completions" as const,
      apiKey: "CATALOG_FIXTURE_KEY",
    };
    const authoredProvider = {
      ...connection,
      models: [
        { id: "latest", cost: { input: 7 } },
        { id: "bare", input: ["text"], cost: { input: 2 } },
        { id: "custom/bare", cost: { output: 8 } },
        {
          id: "alias-exact",
          input: ["text"],
          cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
        },
        { id: "exact" },
      ],
    };
    const cfg = {
      ...configFor(providerId, authoredProvider, mode),
      agents: { defaults: { models: { "custom/latest": {} } } },
    } as unknown as OpenClawConfig;
    const original = structuredClone(cfg);
    const discovered = {
      ...connection,
      models: ["middle", "bare", "custom/bare", "exact", "discovered-only"].map((id) =>
        Object.assign(model(id, ["text", "image"]), {
          cost: id === "custom/bare" ? scopedRates : rates,
        }),
      ),
    };
    const aliases = { latest: "middle", middle: "final", "alias-exact": "exact" };
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: providerId,
          providers: [providerId],
          modelIdNormalization: {
            providers: { [providerId]: { aliases } },
          },
        },
      ],
    });
    const merged = mode === "merge";
    const inheritedInput = merged ? ["text", "image"] : undefined;
    const expected = [
      ["middle", inheritedInput, { ...(merged ? rates : zeroCost), input: 7 }],
      ["bare", ["text"], { ...(merged ? rates : zeroCost), input: 2 }],
      ["custom/bare", inheritedInput, { ...(merged ? scopedRates : zeroCost), output: 8 }],
      ["exact", inheritedInput, merged ? rates : undefined],
      ...(merged ? [["discovered-only", ["text", "image"], rates]] : []),
    ];
    const discovery = discoveryOptions(providerId, discovered);
    await withOpenClawTestState({ label: "catalog-authored-fields" }, async (state) => {
      let existingRaw = "";
      let existingParsed: unknown = {};
      let pluginCatalogs: Array<{ pluginId: string; contents: string }> = [];
      for (let pass = 0; pass < 2; pass++) {
        const plan = await planWrite({
          authStore: { version: 1, profiles: {} },
          cfg,
          agentDir: state.agentDir(),
          env: state.env,
          pluginMetadataSnapshot,
          ...discovery,
          existingRaw,
          existingParsed,
          pluginCatalogs,
        });
        const contents = plan.pluginCatalogWrites?.["plugins/custom/catalog.json"];
        assert(contents, "Expected the plugin-owned catalog");
        const generated = JSON.parse(contents) as { providers: Record<string, ProviderConfig> };
        expect(
          generated.providers[providerId]?.models.map(({ id, input, cost }) => [id, input, cost]),
        ).toEqual(expected);
        expect(cfg).toStrictEqual(original);
        existingRaw = plan.contents;
        existingParsed = JSON.parse(plan.contents);
        pluginCatalogs = [{ pluginId: providerId, contents }];
      }
    });
  },
);

const liveCost = {
  ...rates,
  tieredPricing: [{ ...scopedRates, range: [0] as [number] }],
};
const oldCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const duplicatePrice = { input: 9, output: 8 };
const mergedCost = { ...rates, input: 7, output: 8 };
it.each<[string, Partial<Cost> | undefined, Cost, boolean?, Partial<Cost>?]>([
  ["empty cost", {}, liveCost],
  ["zero cost", zeroCost, zeroCost],
  ["independent config", undefined, oldCost, true],
  ["duplicate partial costs", { input: 7 }, mergedCost, false, duplicatePrice],
])(
  "uses authored %s through discovery and final catalog merging",
  async (_name, cost, expected, independent, duplicateCost) => {
    const providerId = "catalog-price-fixture";
    const configuredModel = {
      ...model("priced-model", ["text", "image"]),
      cost: { ...oldCost, ...cost },
      contextWindow: 4096,
      maxTokens: 512,
      compat: { supportsTools: false },
    };
    const configuredProvider = {
      baseUrl: "https://models.example/v1",
      apiKey: "CATALOG_FIXTURE_KEY",
      models: [configuredModel],
    };
    const cfg: OpenClawConfig = configFor(providerId, configuredProvider);
    const { cost: _materializedCost, ...sourceModel } = configuredModel;
    const authored = { ...sourceModel, ...(cost === undefined ? {} : { cost }) };
    const sourceConfigForSecrets = configFor(" Catalog-Price-Fixture ", {
      ...configuredProvider,
      models: [authored, ...(duplicateCost ? [{ ...configuredModel, cost: duplicateCost }] : [])],
    }) as unknown as OpenClawConfig;
    const discovered = {
      ...configuredProvider,
      models: [
        { ...model("priced-model"), cost: liveCost, compat: configuredModel.compat },
        model("discovered-only"),
      ],
    };
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
    const options = {
      authStore: { version: 1, profiles: {} },
      pluginMetadataSnapshot,
      ...discoveryOptions(providerId, discovered),
    };
    const expectedModels = [{ ...configuredModel, cost: expected }, model("discovered-only")];
    if (independent) {
      // Missing top-level runtime state makes this an independent supplied config.
      setRuntimeConfigSnapshot({ ...cfg, gateway: { mode: "local" } }, sourceConfigForSecrets);
      await withOpenClawTestState({ label: "independent-model-cost" }, async (state) => {
        const plan = await planOpenClawModelsJsonSource(cfg, state.agentDir(), {
          ...options,
          env: state.env,
        });
        expect(JSON.parse(plan.modelsJsonContents!).providers[providerId].models).toEqual(
          expectedModels,
        );
      });
      return;
    }
    setRuntimeConfigSnapshot(cfg, sourceConfigForSecrets);
    const cloned = structuredClone(
      createPreparedModelCatalogWorkerInput({
        agentFacts: {
          input: { config: cfg, agentDir: "/tmp/openclaw-model-cost-presence" },
          env: {},
          authStore: options.authStore,
          credentials: {},
          providerIds: [providerId],
          configuredModelRefs: [],
          configuredRuntimeModels: [],
          runtimeCapabilityModels: [],
          configuredGeneratedCatalogPluginIds: [],
          templateAuthStorage: {} as never,
        },
        pluginMetadataSnapshot,
      }),
    );
    // Workers retain the captured pair after losing the parent's process-local snapshot.
    clearRuntimeConfigSnapshot();
    const plan = await planWrite({
      ...options,
      cfg: cloned.sourceConfigForSecrets,
      discoveryAuthConfig: cloned.input.config,
      agentDir: cloned.input.agentDir,
      env: {},
      existingParsed: {},
    });
    expect(JSON.parse(plan.contents).providers[providerId].models).toEqual(expectedModels);
  },
);
