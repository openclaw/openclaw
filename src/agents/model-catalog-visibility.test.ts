import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRemoteCatalogUrl } from "../model-catalog/remote-config.js";
import { withRemoteModelCatalogSnapshot } from "../model-catalog/remote-overlay.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicySurface from "../plugins/provider-policy-surface.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  prepareLogicalVisibleModelCatalog,
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const entryState = (
  evaluation: ModelAuthAvailabilityEvaluation = { availability: true, routeResolution: null },
) =>
  resolveLogicalModelCatalogEntryState({ evaluation, routePolicy: openAIModelCatalogRoutePolicy });
const visible = (
  params: Pick<
    Parameters<typeof resolveLogicalVisibleModelCatalog>[0],
    "catalog" | "defaultProvider"
  > &
    Partial<Parameters<typeof resolveLogicalVisibleModelCatalog>[0]>,
) =>
  resolveLogicalVisibleModelCatalog({
    cfg: {},
    view: "all",
    routePolicy: openAIModelCatalogRoutePolicy,
    evaluateEntry: async () => entryState(),
    ...params,
  });

describe("resolveLogicalVisibleModelCatalog", () => {
  it("keeps the selected model ahead of curated and live rows in a large catalog", async () => {
    const catalog: ModelCatalogEntry[] = Array.from({ length: 300 }, (_, index) => ({
      provider: "fixture",
      id: `model-${String(index).padStart(3, "0")}`,
      name: `Model ${index}`,
      providerOrder: index,
    }));
    const result = await visible({
      catalog,
      defaultProvider: "fixture",
      defaultModel: { provider: "fixture", model: "model-298" },
      selectedModel: { provider: "fixture", model: "model-299" },
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
    });
    expect(result.slice(0, 3).map((entry) => entry.id)).toEqual([
      "model-299",
      "model-000",
      "model-001",
    ]);
    expect(result).toHaveLength(300);
    expect(new Set(result.map((entry) => entry.id))).toEqual(
      new Set(catalog.map((entry) => entry.id)),
    );
  });

  it("leads each provider with its hosted-catalog recommendations after the selected model", async () => {
    const row = (provider: string, id: string, providerOrder: number): ModelCatalogEntry => ({
      provider,
      id,
      name: id,
      providerOrder,
    });
    const catalog = [
      ...["a-0", "a-1", "a-2", "a-3", "a-4"].map((id, index) => row("alpha", id, index)),
      row("beta", "b-0", 0),
      row("beta", "b-1", 1),
    ];
    const result = await withRemoteModelCatalogSnapshot(
      {
        sourceUrl: resolveRemoteCatalogUrl({}),
        generatedAt: 1,
        revision: "fixture",
        // "gone" is no longer served by alpha; beta recommends nothing.
        recommendations: { alpha: ["a-3", "gone", "a-1"] },
        providers: {},
        pricing: {},
        upstreamPricing: {},
      },
      () =>
        visible({
          catalog,
          defaultProvider: "alpha",
          selectedModel: { provider: "alpha", model: "a-4" },
          metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
        }),
    );
    expect(result.map((entry) => entry.id)).toEqual([
      "a-4",
      "a-3",
      "a-1",
      "a-0",
      "a-2",
      "b-0",
      "b-1",
    ]);
  });

  it.each(["opaque runtime", "projected API"] as const)(
    "applies retirement to effective browse routes: %s",
    async (scenario) => {
      const baseUrl = "https://api.x.ai/v1";
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "xai",
            providers: ["xai"],
            providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
            modelCatalog: {
              providers: { xai: { api: "openai-responses", baseUrl, models: [] } },
              suppressions: [
                {
                  provider: "xai",
                  model: "auto",
                  retirement: { replacedBy: "current" },
                  when: { baseUrlHosts: ["api.x.ai"], providerConfigApiIn: ["openai-responses"] },
                },
              ],
            },
          },
        ],
      });
      const api = scenario === "projected API" ? "openai-completions" : "openai-responses";
      const row: ModelCatalogEntry = {
        provider: "personal",
        id: "auto",
        name: "Auto",
        api,
        baseUrl,
        ...(scenario === "opaque runtime" ? { nativeRuntime: "native-owner" } : {}),
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "personal/auto",
            models: { "personal/auto": {} },
            modelPolicy: { allow: [] },
          },
        },
        ...(scenario === "opaque runtime"
          ? {}
          : {
              models: {
                providers: {
                  personal: {
                    api,
                    baseUrl,
                    models: [
                      makeProviderModelFixture<typeof api>({
                        id: "auto",
                        name: "Auto",
                        provider: "personal",
                        api,
                        baseUrl,
                      }),
                    ].map(({ provider: _provider, ...model }) => model),
                  },
                },
              },
            }),
      };
      const route = {
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      };
      const projected = scenario === "projected API";
      const result = await visible({
        cfg,
        catalog: [row],
        defaultProvider: "personal",
        metadataSnapshot,
        evaluateEntry: async () =>
          entryState({
            availability: true,
            routeResolution: projected ? { kind: "routes", routes: [route] } : null,
            ...(projected ? { selectedRoute: route } : {}),
            ...(scenario === "opaque runtime"
              ? { runtimeAuth: { id: "native-owner", source: "native" as const } }
              : {}),
          }),
      });
      expect(result.map((entry) => entry.id)).toEqual(
        scenario === "opaque runtime" ? ["auto"] : [],
      );
    },
  );

  it("rereads later row identities and policy after entry preparation suspends", async () => {
    const first = { provider: "fixture", id: "first", name: "First" };
    const later = { provider: "fixture", id: "vendor/first", name: "Later" };
    const catalog = [first, later];
    const policy = createModelVisibilityPolicy({
      cfg: {},
      catalog,
      defaultProvider: "fixture",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    const resolvePolicy = vi
      .spyOn(providerPolicySurface, "resolveDirectBundledProviderPolicySurface")
      .mockReturnValue({
        normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^vendor\//u, ""),
      });
    try {
      const preparedEntries: ModelCatalogEntry[] = [];
      const read = await prepareLogicalVisibleModelCatalog({
        cfg: {},
        catalog,
        policy,
        defaultProvider: "fixture",
        view: "all",
        routePolicy: openAIModelCatalogRoutePolicy,
        prepareEntry: async (entry) => {
          preparedEntries.push(entry);
          if (entry === first) {
            await Promise.resolve();
            later.id = "vendor/second";
            resolvePolicy.mockReturnValue(null);
          }
          return () => entryState();
        },
      });
      expect(preparedEntries).toEqual([first, later]);
      expect(read()).toEqual([first, later]);
    } finally {
      resolvePolicy.mockRestore();
    }
  });

  it("keeps case-distinct and literal provider-prefixed identities in the default view", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "fixture", id: "MixedCase", name: "Large", contextWindow: 64_000 },
      { provider: "fixture", id: "mixedcase", name: "Small", contextWindow: 16_000 },
      { provider: "fixture", id: "fixture/MixedCase", name: "Namespaced", contextWindow: 32_000 },
    ];
    const result = await visible({
      cfg: { agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } } },
      catalog,
      defaultProvider: "fixture",
      view: "default",
    });

    expect(result).toEqual(expect.arrayContaining(catalog));
    expect(result).toHaveLength(3);
  });

  it("keeps a literal catalog suffix distinct from its base model", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "fixture", id: "reader", name: "Base" },
      { provider: "fixture", id: "reader@variant", name: "Literal variant" },
    ];
    const result = await visible({
      catalog,
      defaultProvider: "fixture",
    });

    expect(result).toEqual(expect.arrayContaining(catalog));
    expect(result).toHaveLength(2);
  });

  const selectedRoute = {
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription" as const,
    requestTransportOverrides: "none" as const,
  };
  const platform: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "Platform GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
  };
  const chatGPT: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "ChatGPT GPT-5.5",
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 400_000,
    reasoning: false,
    input: ["text"],
  };

  const evaluateSelectedEntry = async () =>
    entryState({
      availability: true,
      routeResolution: { kind: "routes", routes: [selectedRoute] },
      selectedRoute,
    });

  it("preserves provider-owned strongest-first order through route projection", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", providerOrder: 3 },
      { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", providerOrder: 2 },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerOrder: 0 },
      { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", providerOrder: 1 },
    ];

    const result = await visible({
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      catalog,
      defaultProvider: "openai",
      evaluateEntry: evaluateSelectedEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
  });

  it("keeps deprecated configured primary and alias-key rows visible", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "primary", name: "Primary", status: "deprecated" },
      { provider: "demo", id: "alias-key", name: "Alias Key", status: "deprecated" },
      { provider: "demo", id: "hidden", name: "Hidden", status: "deprecated" },
    ];
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "demo/primary" },
          models: { "demo/alias-key": { alias: "legacy" } },
          modelPolicy: {},
        },
      },
    } as OpenClawConfig;
    // This unit test covers configured-row retention, not runtime plugin
    // discovery. Keep fake provider refs on the deterministic static path.
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await visible({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      view: "configured",
      policy,
    });

    expect(result.map((entry) => entry.id).toSorted()).toEqual(["alias-key", "primary"]);
  });

  it("dedupes physical routes after selected-route projection in the default view", async () => {
    const catalog = [
      { ...platform, alias: "platform" },
      { ...chatGPT, alias: "selected" },
    ];
    const result = await visible({
      catalog,
      defaultProvider: "openai",
      view: "default",
      evaluateEntry: evaluateSelectedEntry,
    });

    expect(result).toEqual([{ ...chatGPT, alias: "selected" }]);
  });

  it("uses the selected route's deprecated lifecycle status", async () => {
    const platformAvailable = { ...platform, status: "available" as const };
    const chatGPTSelected = { ...chatGPT, status: "deprecated" as const };
    const catalog = [platformAvailable, chatGPTSelected];
    const result = await visible({
      catalog,
      routeVariants: catalog,
      defaultProvider: "openai",
      view: undefined,
      evaluateEntry: evaluateSelectedEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual([]);
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const result = await visible({
      catalog: [platform],
      defaultProvider: "openai",
      evaluateEntry: async () =>
        entryState({
          availability: false,
          routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
        }),
    });

    expect(result).toEqual([{ provider: "openai", id: "gpt-5.5", name: "Platform GPT-5.5" }]);
  });
});
