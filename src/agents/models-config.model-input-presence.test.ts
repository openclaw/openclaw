import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { planOpenClawModelsJsonSource } from "./models-config.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

function model(id: string, input: Array<"text" | "image"> = ["text"]) {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
  };
}

function discoveryOptions(providerId: string, discovered: ProviderConfig) {
  const provider: ProviderPlugin = {
    id: providerId,
    pluginId: providerId,
    label: "Catalog fixture",
    auth: [],
    staticCatalog: { run: async () => ({ provider: discovered }) },
  };
  return {
    preparedStaticProviderCatalog: {
      providers: [provider],
      entries: [
        {
          provider,
          providerConfigs: { [providerId]: discovered },
        },
      ],
    },
    providerDiscoveryEntriesOnly: true,
    providerDiscoveryProviderIds: [providerId],
  };
}

function writePlan(plan: Awaited<ReturnType<typeof planModelsJsonForTest>>) {
  if (plan.action !== "write") {
    throw new Error("Expected catalog write plan");
  }
  return plan;
}

describe("models config input presence", () => {
  it.each(["merge", "replace"] as const)(
    "keeps one-step identities and exact source fields through repeated %s planning",
    async (mode) => {
      const providerId = "custom";
      const rates = { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 };
      const scopedRates = { input: 33, output: 44, cacheRead: 5, cacheWrite: 6 };
      const sourceModel = (
        id: string,
        fields: {
          input?: Array<"text" | "image">;
          cost?: Partial<ModelDefinitionConfig["cost"]>;
        } = {},
      ) => {
        const { input: _input, cost: _cost, ...row } = model(id);
        return { ...row, ...fields };
      };
      const cfg = {
        models: {
          mode,
          providers: {
            [providerId]: {
              baseUrl: "https://catalog-fields.example/v1",
              api: "openai-completions",
              apiKey: "CATALOG_FIXTURE_KEY",
              models: [
                sourceModel("latest", { cost: { input: 7 } }),
                sourceModel("bare", { input: ["text"], cost: { input: 2 } }),
                sourceModel("custom/bare", { cost: { output: 8 } }),
                sourceModel("alias-exact", {
                  input: ["text"],
                  cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
                }),
                sourceModel("exact"),
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const original = structuredClone(cfg);
      const discovered = {
        baseUrl: "https://catalog-fields.example/v1",
        api: "openai-completions" as const,
        apiKey: "CATALOG_FIXTURE_KEY",
        models: ["middle", "bare", "custom/bare", "exact", "discovered-only"].map((id) =>
          Object.assign(model(id, ["text", "image"]), {
            cost: id === "custom/bare" ? scopedRates : rates,
          }),
        ),
      };
      const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: providerId,
            providers: [providerId],
            modelIdNormalization: {
              providers: {
                [providerId]: {
                  aliases: { latest: "middle", middle: "final", "alias-exact": "exact" },
                },
              },
            },
          },
        ],
      });
      const merged = mode === "merge";
      const emptyRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const inheritedInput = merged ? ["text", "image"] : undefined;
      const expected = [
        {
          id: "middle",
          input: inheritedInput,
          cost: { ...(merged ? rates : emptyRates), input: 7 },
        },
        { id: "bare", input: ["text"], cost: { ...(merged ? rates : emptyRates), input: 2 } },
        {
          id: "custom/bare",
          input: inheritedInput,
          cost: { ...(merged ? scopedRates : emptyRates), output: 8 },
        },
        { id: "exact", input: inheritedInput, cost: merged ? rates : undefined },
        ...(merged ? [{ id: "discovered-only", input: ["text", "image"], cost: rates }] : []),
      ];
      const discovery = discoveryOptions(providerId, discovered);
      await withOpenClawTestState({ label: "catalog-authored-fields" }, async (state) => {
        let existingRaw = "";
        let existingParsed: unknown = {};
        let pluginCatalogs: Array<{ pluginId: string; contents: string }> = [];
        for (let pass = 0; pass < 2; pass++) {
          const plan = writePlan(
            await planOpenClawModelsJson({
              authStore: { version: 1, profiles: {} },
              context: {
                cfg,
                discoveryAuthConfig: cfg,
                sourceConfigForSecrets: cfg,
                agentDir: state.agentDir(),
                env: state.env,
                envFingerprint: state.env,
                pluginMetadataSnapshot,
                ...discovery,
              },
              existingRaw,
              existingParsed,
              pluginCatalogs,
            }),
          );
          const contents = plan.pluginCatalogWrites?.["plugins/custom/catalog.json"];
          if (!contents) {
            throw new Error("Expected the plugin-owned catalog");
          }
          const generated = JSON.parse(contents) as {
            providers: Record<string, { models: ModelDefinitionConfig[] }>;
          };
          expect(
            generated.providers[providerId]?.models.map(({ id, input, cost }) => ({
              id,
              input,
              cost,
            })),
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
    input: 11,
    output: 22,
    cacheRead: 3,
    cacheWrite: 4,
    tieredPricing: [{ input: 33, output: 44, cacheRead: 5, cacheWrite: 6, range: [0] as [number] }],
  };
  const oldCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  it.each<{
    name: string;
    cost?: Partial<ModelDefinitionConfig["cost"]>;
    expected: ModelDefinitionConfig["cost"];
    independent?: boolean;
    duplicateCost?: Partial<ModelDefinitionConfig["cost"]>;
  }>([
    { name: "empty cost", cost: {}, expected: liveCost },
    {
      name: "zero cost",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { name: "independent config", independent: true, expected: oldCost },
    {
      name: "duplicate partial costs",
      cost: { input: 7 },
      duplicateCost: { input: 9, output: 8 },
      expected: { input: 7, output: 8, cacheRead: 3, cacheWrite: 4 },
    },
  ])(
    "uses authored $name through discovery and final catalog merging",
    async ({ cost, expected, independent, duplicateCost }) => {
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
      const cfg: OpenClawConfig = { models: { providers: { [providerId]: configuredProvider } } };
      const { cost: _materializedCost, ...sourceModel } = configuredModel;
      const sourceConfigForSecrets = {
        models: {
          providers: {
            " Catalog-Price-Fixture ": {
              ...configuredProvider,
              models: [
                {
                  ...sourceModel,
                  ...(cost === undefined ? {} : { cost }),
                },
                ...(duplicateCost ? [{ ...configuredModel, cost: duplicateCost }] : []),
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
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
      if (independent) {
        // Missing top-level runtime state makes this an independent supplied config.
        setRuntimeConfigSnapshot({ ...cfg, gateway: { mode: "local" } }, sourceConfigForSecrets);
        await withOpenClawTestState({ label: "independent-model-cost" }, async (state) => {
          const plan = await planOpenClawModelsJsonSource(cfg, state.agentDir(), {
            ...options,
            env: state.env,
          });
          expect(JSON.parse(plan.modelsJsonContents!).providers[providerId].models).toEqual([
            { ...configuredModel, cost: expected },
            model("discovered-only"),
          ]);
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
      const plan = writePlan(
        await planModelsJsonForTest({
          ...options,
          cfg: cloned.sourceConfigForSecrets,
          discoveryAuthConfig: cloned.input.config,
          sourceConfigForSecrets: cloned.sourceConfigForSecrets,
          agentDir: cloned.input.agentDir,
          env: {},
          existingRaw: "",
          existingParsed: {},
        }),
      );
      const generated = JSON.parse(plan.contents);
      expect(generated.providers[providerId].models).toEqual([
        { ...configuredModel, cost: expected },
        model("discovered-only"),
      ]);
    },
  );
});
