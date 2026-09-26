import { describe, expect, it } from "vitest";
import { materializeRuntimeConfig } from "../../config/materialize.js";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { extractModelCompat } from "../../plugins/provider-model-compat.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import { resolveRuntimeHooks } from "./model.provider-hooks.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./model.static-id.js";

const provider = "route-compat-fixture";
const catalogRoute = { api: "openai-responses", baseUrl: "https://catalog.example/v1" } as const;
const anthropicRoute = { api: "anthropic-messages", baseUrl: "https://catalog.example" } as const;
const customRoute = { ...catalogRoute, baseUrl: "https://custom.example/v1" };
const catalogCompat: ModelCompatConfig = { codeMode: "preferred", supportsTemperature: false };
const configuredModel: ModelDefinitionConfig = {
  id: "model",
  name: "Configured model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
};

function createCatalogFixture(
  route: { api: NonNullable<ModelProviderConfig["api"]>; baseUrl: string } = catalogRoute,
) {
  const catalogModel = {
    ...makeProviderModelFixture({
      provider,
      id: configuredModel.id,
      ...route,
      compat: catalogCompat,
    }),
    contextWindow: 16_000,
  };
  const { api: _api, baseUrl: _baseUrl, provider: _provider, ...catalogDefinition } = catalogModel;
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: provider,
        providers: [provider],
        modelCatalog: {
          discovery: { [provider]: "static" },
          providers: { [provider]: { ...route, models: [catalogDefinition] } },
        },
      },
    ],
  });
  return { route, catalogModel, metadataSnapshot };
}

function createResolutionOptions(
  config: OpenClawConfig,
  { route, catalogModel, metadataSnapshot }: ReturnType<typeof createCatalogFixture>,
) {
  const stores = createEmptyAgentDiscoveryStores();
  stores.modelRegistry.registerProvider(provider, { ...route, models: [catalogModel] });
  const configuredRuntimeModels = [{ provider, modelId: catalogModel.id, model: catalogModel }];
  const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
    catalogOwner: undefined,
    agentDir: "/tmp/route-compat-fixture",
    activeProjectKeys: [],
    allowGatewaySubagentBinding: false,
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels,
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      metadataSnapshot,
    ),
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}),
    createStores: () => stores,
  };
  return { ...stores, preparedModelRuntime, skipAgentDiscovery: true };
}

describe("model route compatibility", () => {
  const cases: Array<{
    name: string;
    catalog?: Parameters<typeof createCatalogFixture>[0];
    route: Pick<ModelProviderConfig, "api" | "baseUrl">;
    modelRoute?: Pick<ModelDefinitionConfig, "api" | "baseUrl">;
    authored: ModelCompatConfig | undefined;
    expected: ModelCompatConfig | undefined;
    expectedBaseUrl?: string;
  }> = [
    { name: "catalog", route: catalogRoute, authored: undefined, expected: catalogCompat },
    {
      name: "Anthropic versioned catalog endpoint",
      catalog: anthropicRoute,
      route: { ...anthropicRoute, baseUrl: `${anthropicRoute.baseUrl}/v1` },
      authored: undefined,
      expected: catalogCompat,
      expectedBaseUrl: anthropicRoute.baseUrl,
    },
    {
      name: "Anthropic versioned catalog endpoint with trailing slash",
      catalog: anthropicRoute,
      route: { ...anthropicRoute, baseUrl: `${anthropicRoute.baseUrl}/v1/` },
      authored: undefined,
      expected: catalogCompat,
      expectedBaseUrl: anthropicRoute.baseUrl,
    },
    {
      name: "Anthropic custom endpoint",
      catalog: anthropicRoute,
      route: { ...anthropicRoute, baseUrl: "https://custom.example/v1" },
      authored: undefined,
      expected: undefined,
      expectedBaseUrl: "https://custom.example",
    },
    {
      name: "normalized catalog endpoint",
      route: { ...catalogRoute, baseUrl: `${catalogRoute.baseUrl}/` },
      authored: undefined,
      expected: catalogCompat,
    },
    {
      name: "catalog with authored preference",
      route: catalogRoute,
      authored: { codeMode: "capable" },
      expected: catalogCompat,
    },
    { name: "custom endpoint", route: customRoute, authored: undefined, expected: undefined },
    {
      name: "model endpoint override",
      route: catalogRoute,
      modelRoute: customRoute,
      authored: undefined,
      expected: undefined,
    },
    {
      name: "custom API",
      route: { ...catalogRoute, api: "openai-completions" },
      authored: undefined,
      expected: undefined,
    },
    {
      name: "custom capable",
      route: customRoute,
      authored: { codeMode: "capable" },
      expected: { codeMode: "capable" },
    },
    {
      name: "custom preferred",
      route: customRoute,
      authored: { codeMode: "preferred" },
      expected: { codeMode: "preferred" },
    },
  ];
  it.each(cases)(
    "keeps $name capabilities bound to their route",
    async ({ catalog, route, modelRoute, authored, expected, expectedBaseUrl }) => {
      const fixture = createCatalogFixture(catalog);
      const { catalogModel, metadataSnapshot } = fixture;
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const source: OpenClawConfig = {
          models: {
            providers: {
              [provider]: {
                ...route,
                models: [
                  {
                    ...configuredModel,
                    ...modelRoute,
                    ...(authored ? { compat: authored } : {}),
                  },
                ],
              },
            },
          },
        };
        const materialized = materializeRuntimeConfig(source, {
          manifestRegistry: metadataSnapshot.manifestRegistry,
        });
        // Both config-file loads and callers with already normalized inline rows use this resolver.
        for (const config of [source, materialized]) {
          const resolved = await resolveModelAsync(provider, catalogModel.id, undefined, config, {
            ...createResolutionOptions(config, fixture),
            skipProviderRuntimeHooks: true,
          });
          expect(resolved.error).toBeUndefined();
          const configSource = config === source ? "source" : "materialized";
          if (expectedBaseUrl !== undefined) {
            expect.soft(resolved.model?.baseUrl, configSource).toBe(expectedBaseUrl);
          }
          const compat = extractModelCompat(resolved.model);
          expect.soft(compat?.codeMode, configSource).toBe(expected?.codeMode);
          expect
            .soft(compat?.supportsTemperature, configSource)
            .toBe(expected?.supportsTemperature);
          const surface = resolveAgentToolSurfacePlan({
            config,
            model: resolved.model,
            modelProvider: provider,
            modelId: catalogModel.id,
            toolsEnabled: true,
            forceDirectMessageTool: false,
            isRawModelRun: false,
          });
          expect
            .soft(surface.codeModeControlsEnabled, configSource)
            .toBe(expected?.codeMode === "preferred");
          expect
            .soft(surface.toolSearchControlsEnabled, configSource)
            .toBe(expected?.codeMode !== "preferred");
        }
      });
    },
  );

  const discoveredCompat: ModelCompatConfig = { codeMode: "capable" };
  it.each([
    {
      name: "retained discovered route",
      providerOnly: false,
      route: customRoute,
      discoveredRoute: customRoute,
      expected: discoveredCompat,
    },
    {
      name: "configured catalog route",
      providerOnly: false,
      route: catalogRoute,
      discoveredRoute: customRoute,
      expected: catalogCompat,
    },
    {
      name: "provider-only catalog route",
      providerOnly: true,
      route: catalogRoute,
      discoveredRoute: customRoute,
      expected: catalogCompat,
    },
    {
      name: "same-route discovery refresh",
      providerOnly: false,
      route: catalogRoute,
      discoveredRoute: catalogRoute,
      expected: { ...catalogCompat, ...discoveredCompat },
    },
  ])(
    "keeps capabilities from the $name when discovery is preferred",
    async ({ route, discoveredRoute, expected, providerOnly }) => {
      const fixture = createCatalogFixture();
      const { catalogModel, metadataSnapshot } = fixture;
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const source: OpenClawConfig = {
          models: {
            providers: {
              [provider]: { ...route, models: providerOnly ? [] : [configuredModel] },
            },
          },
        };
        const materialized = materializeRuntimeConfig(source, {
          manifestRegistry: metadataSnapshot.manifestRegistry,
        });
        for (const config of [source, materialized]) {
          const resolved = await resolveModelAsync(provider, catalogModel.id, undefined, config, {
            ...createResolutionOptions(config, fixture),
            authProfileMode: "api_key",
            runtimeHooks: {
              ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
              shouldPreferProviderRuntimeResolvedModel: () => true,
              runProviderDynamicModel: () => ({
                ...catalogModel,
                ...discoveredRoute,
                compat: discoveredCompat,
              }),
            },
          });
          const configSource = config === source ? "source" : "materialized";
          expect(resolved.error).toBeUndefined();
          expect.soft(resolved.model?.baseUrl, configSource).toBe(route.baseUrl);
          expect.soft(resolved.model?.compat, configSource).toEqual(expected);
        }
      });
    },
  );
});
