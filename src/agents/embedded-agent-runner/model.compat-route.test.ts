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
import { model as makeCatalogModel } from "../model-catalog-fixtures.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import { createEmptyPreparedModelRuntimeFixture } from "./model.fixture.test-support.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import { resolveRuntimeHooks } from "./model.provider-hooks.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./model.static-id.js";

const provider = "route-compat-fixture";
const catalogRoute = { api: "openai-responses", baseUrl: "https://catalog.example/v1" } as const;
const anthropicRoute = { api: "anthropic-messages", baseUrl: "https://catalog.example" } as const;
const customRoute = { ...catalogRoute, baseUrl: "https://custom.example/v1" };
const catalogCompat: ModelCompatConfig = { codeMode: "preferred", supportsTemperature: false };
const configuredModel: ModelDefinitionConfig = makeCatalogModel("model", "Configured model", {
  maxTokens: 4096,
});

function providerConfig(
  route: Pick<ModelProviderConfig, "api" | "baseUrl">,
  models: ModelDefinitionConfig[],
  providerId = provider,
): OpenClawConfig {
  return { models: { providers: { [providerId]: { ...route, models } } } };
}

function configVariants(source: OpenClawConfig, fixture: ReturnType<typeof createCatalogFixture>) {
  return [
    source,
    materializeRuntimeConfig(source, {
      manifestRegistry: fixture.metadataSnapshot.manifestRegistry,
    }),
  ];
}

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
  providerId = provider,
) {
  const stores = createEmptyAgentDiscoveryStores();
  stores.modelRegistry.registerProvider(providerId, { ...route, models: [catalogModel] });
  const configuredRuntimeModels = [
    { provider: providerId, modelId: catalogModel.id, model: catalogModel },
  ];
  const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
    ...createEmptyPreparedModelRuntimeFixture({
      agentDir: "/tmp/route-compat-fixture",
      config,
      metadataSnapshot,
      createStores: () => stores,
    }),
    configuredRuntimeModels,
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      metadataSnapshot,
    ),
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}),
  };
  return { ...stores, preparedModelRuntime, skipAgentDiscovery: true };
}

describe("model route compatibility", () => {
  it.each([
    {
      name: "prepared catalog capabilities",
      id: "anthropic/claude-opus-5.5",
      catalogCompat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"],
      },
      configuredCompat: undefined,
      thinkingLevelMap: { off: null },
      requestedLevel: "xhigh" as const,
      expectedScalarSupport: true,
      expectedEfforts: expect.arrayContaining(["xhigh"]),
      expectedReasoning: { effort: "xhigh" },
    },
    {
      name: "declared ladder over a binary catalog guess",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false },
      configuredCompat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
      thinkingLevelMap: undefined,
      requestedLevel: "max" as const,
      expectedScalarSupport: true,
      expectedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      expectedReasoning: { effort: "max" },
    },
    {
      name: "declared disable control over a binary catalog guess",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false },
      configuredCompat: { supportedReasoningEfforts: ["none", "low", "high"] },
      thinkingLevelMap: undefined,
      requestedLevel: "off" as const,
      expectedScalarSupport: true,
      expectedEfforts: ["none", "low", "high"],
      expectedReasoning: { effort: "none" },
    },
    {
      name: "declared scalar opt-in over an empty catalog ladder",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false, supportedReasoningEfforts: [] },
      configuredCompat: { supportsReasoningEffort: true },
      thinkingLevelMap: undefined,
      requestedLevel: "high" as const,
      expectedScalarSupport: true,
      expectedEfforts: undefined,
      expectedReasoning: { effort: "high" },
    },
    {
      name: "declared scalar opt-in with an accepted catalog ladder",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
      configuredCompat: { supportsReasoningEffort: true },
      thinkingLevelMap: undefined,
      requestedLevel: "high" as const,
      expectedScalarSupport: true,
      expectedEfforts: ["low", "high"],
      expectedReasoning: { effort: "high" },
    },
    {
      name: "declared map over an empty catalog ladder",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false, supportedReasoningEfforts: [] },
      configuredCompat: { reasoningEffortMap: { high: "medium" } },
      thinkingLevelMap: undefined,
      requestedLevel: "high" as const,
      expectedScalarSupport: true,
      expectedEfforts: undefined,
      expectedReasoning: { effort: "medium" },
    },
    {
      name: "explicit scalar opt-out over a declared map",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false, supportedReasoningEfforts: [] },
      configuredCompat: { supportsReasoningEffort: false, reasoningEffortMap: { high: "medium" } },
      thinkingLevelMap: undefined,
      requestedLevel: "high" as const,
      expectedScalarSupport: false,
      expectedEfforts: [],
      expectedReasoning: { enabled: true },
    },
    {
      name: "binary catalog without a declared ladder",
      id: "fixture/reasoning-model",
      catalogCompat: { supportsReasoningEffort: false },
      configuredCompat: undefined,
      thinkingLevelMap: undefined,
      requestedLevel: "off" as const,
      expectedScalarSupport: false,
      expectedEfforts: undefined,
      expectedReasoning: { enabled: false },
    },
  ])("retains OpenRouter $name on the catalog route", async (testCase) => {
    const reasoning = true;
    const providerId = "openrouter";
    const id = testCase.id;
    const baseUrl = "https://openrouter.ai/api/v1";
    const route = { api: "openai-completions" as const, baseUrl };
    const catalogModel = {
      ...makeProviderModelFixture({ provider: providerId, id, ...route }),
      reasoning: true,
      contextWindow: 1_000_000,
      thinkingLevelMap: testCase.thinkingLevelMap,
      compat: testCase.catalogCompat,
    };
    const configured = {
      ...makeProviderModelFixture({ provider: providerId, id, api: route.api, baseUrl }),
      reasoning,
      contextWindow: 200_000,
      contextTokens: 520_000,
      thinkingLevelMap: undefined,
      compat: {
        supportsDeveloperRole: false,
        ...testCase.configuredCompat,
      },
    };
    const config = providerConfig(
      route,
      [
        {
          ...configuredModel,
          id,
          name: id,
          reasoning,
          contextTokens: 520_000,
          maxTokens: 128_000,
          compat: testCase.configuredCompat,
        },
      ],
      providerId,
    );
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const { preparedModelRuntime } = createResolutionOptions(
      config,
      { route, catalogModel: configured, metadataSnapshot },
      providerId,
    );
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
    expect(resolved.model).toMatchObject({
      contextTokens: 520_000,
      reasoning,
      compat: {
        supportsReasoningEffort: testCase.expectedScalarSupport,
      },
    });
    expect(extractModelCompat(resolved.model)?.supportedReasoningEfforts).toEqual(
      testCase.expectedEfforts,
    );
    expect(resolved.model?.thinkingLevelMap).toEqual(testCase.thinkingLevelMap);
    expect(clampThinkingLevel(resolved.model!, testCase.requestedLevel)).toBe(
      testCase.requestedLevel,
    );
    // Exercise the real outbound request path with a local transport response.
    // Retain only allowlisted request settings; never persist prompt or auth data.
    const requests: Array<{ model?: string; reasoning?: { effort?: string; enabled?: boolean } }> =
      [];
    const host = getAiTransportHost();
    configureAiTransportHost({
      ...host,
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/v1/chat/completions");
        const payload = (await request.json()) as {
          model?: string;
          reasoning?: { effort?: string; enabled?: boolean };
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
        { apiKey: "synthetic-key", reasoning: testCase.requestedLevel, transport: "sse" },
      );
      const result = await stream.result();
      expect(result.errorMessage).toBeUndefined();
      expect(requests).toEqual([{ model: id, reasoning: testCase.expectedReasoning }]);
    } finally {
      configureAiTransportHost(host);
    }
  });

  const cases: Array<{
    name: string;
    catalog?: Parameters<typeof createCatalogFixture>[0];
    route: Pick<ModelProviderConfig, "api" | "baseUrl">;
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
      name: "custom API without authored capabilities",
      route: { ...catalogRoute, api: "openai-completions" },
      authored: undefined,
      expected: undefined,
    },
  ];
  it.each(cases)(
    "keeps $name capabilities bound to their route",
    async ({ catalog, route, authored, expected, expectedBaseUrl }) => {
      const fixture = createCatalogFixture(catalog);
      const { catalogModel, metadataSnapshot } = fixture;
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const source = providerConfig(route, [
          { ...configuredModel, ...(authored ? { compat: authored } : {}) },
        ]);
        // Both config-file loads and callers with already normalized inline rows use this resolver.
        for (const config of configVariants(source, fixture)) {
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
          expect.soft(surface, configSource).toMatchObject({
            codeModeControlsEnabled: expected?.codeMode === "preferred",
            toolSearchControlsEnabled: expected?.codeMode !== "preferred",
          });
        }
      });
    },
  );

  const discoveredCompat: ModelCompatConfig = { codeMode: "capable" };
  it("keeps capabilities from the provider-only catalog route when discovery is preferred", async () => {
    const fixture = createCatalogFixture();
    const { catalogModel, metadataSnapshot } = fixture;
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const source = providerConfig(catalogRoute, []);
      for (const config of configVariants(source, fixture)) {
        const resolved = await resolveModelAsync(provider, catalogModel.id, undefined, config, {
          ...createResolutionOptions(config, fixture),
          authProfileMode: "api_key",
          runtimeHooks: {
            ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
            shouldPreferProviderRuntimeResolvedModel: () => true,
            runProviderDynamicModel: () => ({
              ...catalogModel,
              ...customRoute,
              compat: discoveredCompat,
            }),
          },
        });
        const configSource = config === source ? "source" : "materialized";
        expect(resolved.error).toBeUndefined();
        expect.soft(resolved.model?.baseUrl, configSource).toBe(catalogRoute.baseUrl);
        expect.soft(resolved.model?.compat, configSource).toEqual(catalogCompat);
      }
    });
  });
});
