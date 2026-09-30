import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import { describe, expect, it } from "vitest";
import { createOpenAICompletionsTransportStreamFn } from "../../../packages/ai/src/transports/openai-completions-transport.js";
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
  it.each([
    { name: "catalog route", baseUrl: "https://openrouter.ai/api/v1", reasoning: true },
    {
      name: "explicit reasoning opt-out",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
    },
    { name: "custom route", baseUrl: "https://custom.example/v1", reasoning: true },
  ])(
    "retains prepared OpenRouter reasoning capabilities on the $name",
    async ({ baseUrl, reasoning }) => {
      const providerId = "openrouter";
      const id = "anthropic/claude-opus-5.5";
      const route = { api: "openai-completions" as const, baseUrl: "https://openrouter.ai/api/v1" };
      const catalogModel = {
        ...makeProviderModelFixture({ provider: providerId, id, ...route }),
        reasoning: true,
        contextWindow: 1_000_000,
        thinkingLevelMap: { off: null },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"],
        },
      };
      const configured = {
        ...makeProviderModelFixture({ provider: providerId, id, api: route.api, baseUrl }),
        reasoning,
        contextWindow: 200_000,
        contextTokens: 520_000,
        thinkingLevelMap: undefined,
        compat: {
          supportsDeveloperRole: false,
          ...(baseUrl !== route.baseUrl
            ? { supportedReasoningEfforts: ["low", "medium", "high"] }
            : {}),
        },
      };
      const config: OpenClawConfig = {
        models: {
          providers: {
            openrouter: {
              api: route.api,
              baseUrl,
              models: [
                {
                  id,
                  name: id,
                  reasoning,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextTokens: 520_000,
                  maxTokens: 128_000,
                  ...(baseUrl !== route.baseUrl
                    ? { compat: { supportedReasoningEfforts: ["low", "medium", "high"] } }
                    : {}),
                },
              ],
            },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const configuredRuntimeModels = [{ provider: providerId, modelId: id, model: configured }];
      const stores = createEmptyAgentDiscoveryStores();
      stores.modelRegistry.registerProvider(providerId, {
        api: route.api,
        baseUrl,
        models: [configured],
      });
      const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
        catalogOwner: undefined,
        agentDir: "/tmp/prepared-openrouter-reasoning",
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
      const resolved = await resolveModelAsync(providerId, id, undefined, config, {
        preparedModelRuntime,
        skipAgentDiscovery: true,
        authProfileMode: "api_key",
        runtimeHooks: {
          ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
          shouldPreferProviderRuntimeResolvedModel: () => baseUrl === route.baseUrl,
          runProviderDynamicModel: () => catalogModel,
        },
        allowBundledStaticCatalogFallback: true,
      });
      expect(resolved.error).toBeUndefined();
      expect(resolved.model?.contextTokens).toBe(520_000);
      expect(resolved.model?.reasoning).toBe(reasoning);
      if (baseUrl === route.baseUrl) {
        expect(resolved.model?.compat).toMatchObject({
          supportsReasoningEffort: true,
          supportedReasoningEfforts: expect.arrayContaining(["xhigh"]),
        });
        expect(resolved.model?.thinkingLevelMap).toEqual({ off: null });
        expect(clampThinkingLevel(resolved.model!, "xhigh")).toBe(reasoning ? "xhigh" : "off");
        if (reasoning) {
          // Exercise the real outbound request path with a local transport response.
          // Retain only allowlisted request settings; never persist prompt or auth data.
          const requests: Array<{ model?: string; reasoning?: { effort?: string } }> = [];
          const host = getAiTransportHost();
          configureAiTransportHost({
            ...host,
            buildModelFetch: () => async (input, init) => {
              const request = new Request(input, init);
              expect(new URL(request.url).pathname).toBe("/api/v1/chat/completions");
              const payload = (await request.json()) as {
                model?: string;
                reasoning?: { effort?: string };
              };
              requests.push({ model: payload.model, reasoning: payload.reasoning });
              const event = {
                id: "synthetic-reply",
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
              };
              return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
              });
            },
          });
          try {
            const stream = await createOpenAICompletionsTransportStreamFn()(
              resolved.model!,
              { messages: [{ role: "user", content: "Synthetic test", timestamp: 1 }] },
              { apiKey: "synthetic-key", reasoning: "xhigh", transport: "sse" },
            );
            const result = await stream.result();
            expect(result.errorMessage).toBeUndefined();
            expect(requests).toEqual([{ model: id, reasoning: { effort: "xhigh" } }]);
          } finally {
            configureAiTransportHost(host);
          }
        }
      } else {
        expect(resolved.model?.baseUrl).toBe(baseUrl);
        expect(resolved.model?.compat).toMatchObject({
          supportedReasoningEfforts: ["low", "medium", "high"],
        });
        expect(clampThinkingLevel(resolved.model!, "xhigh")).toBe("high");
      }
    },
  );

  const cases: Array<{
    name: string;
    catalog?: Parameters<typeof createCatalogFixture>[0];
    route: Pick<ModelProviderConfig, "api" | "baseUrl">;
    modelRoute?: Pick<ModelDefinitionConfig, "api" | "baseUrl">;
    authored: ModelCompatConfig | undefined;
    expected: ModelCompatConfig | undefined;
    expectedBaseUrl?: string;
  }> = [
    {
      name: "Anthropic versioned catalog endpoint with an authored preference",
      catalog: anthropicRoute,
      route: { ...anthropicRoute, baseUrl: `${anthropicRoute.baseUrl}/v1/` },
      authored: { codeMode: "capable" },
      expected: catalogCompat,
      expectedBaseUrl: anthropicRoute.baseUrl,
    },
    {
      name: "model endpoint override with authored capabilities",
      route: catalogRoute,
      modelRoute: customRoute,
      authored: { codeMode: "capable" },
      expected: { codeMode: "capable" },
    },
    {
      name: "custom API without authored capabilities",
      route: { ...catalogRoute, api: "openai-completions" },
      authored: undefined,
      expected: undefined,
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
