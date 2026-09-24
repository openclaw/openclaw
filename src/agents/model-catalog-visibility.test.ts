/**
 * Regression coverage for model catalog visibility filtering.
 * Keeps provider/model allow and hide rules aligned with catalog row metadata.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicySurface from "../plugins/provider-policy-surface.js";
import {
  prepareLogicalVisibleModelCatalog,
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("resolveLogicalVisibleModelCatalog", () => {
  it.each([
    "native",
    "custom",
    "opaque runtime",
    "native donor with host route",
    "projected custom",
    "projected API",
  ] as const)("applies retirement to effective browse routes: %s", async (scenario) => {
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
    const rowBaseUrl = scenario === "custom" ? "https://custom.invalid/v1" : baseUrl;
    const api = scenario === "projected API" ? "openai-completions" : "openai-responses";
    const row: ModelCatalogEntry = {
      provider: "personal",
      id: "auto",
      name: "Auto",
      api,
      baseUrl: rowBaseUrl,
      ...(scenario === "opaque runtime" || scenario === "native donor with host route"
        ? { nativeRuntime: "native-owner" }
        : {}),
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
                  baseUrl: rowBaseUrl,
                  models: [
                    makeProviderModelFixture<typeof api>({
                      id: "auto",
                      name: "Auto",
                      provider: "personal",
                      api,
                      baseUrl: rowBaseUrl,
                    }),
                  ].map(({ provider: _provider, ...model }) => model),
                },
              },
            },
          }),
    };
    const route = {
      api: "openai-responses" as const,
      baseUrl: scenario === "projected custom" ? "https://custom.invalid/v1" : baseUrl,
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
    };
    const projected = scenario === "projected custom" || scenario === "projected API";
    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [row],
      defaultProvider: "personal",
      view: "all",
      metadataSnapshot,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: true,
            routeResolution: projected ? { kind: "routes", routes: [route] } : null,
            ...(projected ? { selectedRoute: route } : {}),
            ...(scenario === "opaque runtime"
              ? { runtimeAuth: { id: "native-owner", source: "native" as const } }
              : {}),
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });
    const visible =
      scenario === "custom" || scenario === "opaque runtime" || scenario === "projected custom";
    expect(result.map((entry) => entry.id)).toEqual(visible ? ["auto"] : []);
  });

  it("bounds identity discovery before asynchronous entry preparation", async () => {
    const catalog = Array.from({ length: 64 }, (_, index) => ({
      provider: "fixture",
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    const policy = createModelVisibilityPolicy({
      cfg: {},
      catalog,
      defaultProvider: "fixture",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    const resolvePolicy = vi
      .spyOn(providerPolicySurface, "resolveDirectBundledProviderPolicySurface")
      .mockReturnValue(null);
    try {
      const prepared = prepareLogicalVisibleModelCatalog({
        cfg: {},
        catalog,
        policy,
        defaultProvider: "fixture",
        view: "all",
        routePolicy: openAIModelCatalogRoutePolicy,
        prepareEntry: async () => () =>
          resolveLogicalModelCatalogEntryState({
            evaluation: { availability: true, routeResolution: null },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });
      const initialPolicyReads = resolvePolicy.mock.calls.length;
      const read = await prepared;

      const rows = read();
      expect(rows).toEqual(expect.arrayContaining(catalog));
      expect(rows).toHaveLength(catalog.length);
      expect(initialPolicyReads).toBeLessThanOrEqual(2);
      const normalize = vi.fn(({ modelId }: { modelId: string }) => modelId);
      resolvePolicy.mockReturnValue({ normalizeModelCatalogId: normalize });
      expect(read()).toEqual(rows);
      expect(normalize).toHaveBeenCalled();
    } finally {
      resolvePolicy.mockRestore();
    }
  });

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
          return () =>
            resolveLogicalModelCatalogEntryState({
              evaluation: { availability: true, routeResolution: null },
              routePolicy: openAIModelCatalogRoutePolicy,
            });
        },
      });
      expect(preparedEntries).toEqual([first, later]);
      expect(read()).toEqual([first, later]);
    } finally {
      resolvePolicy.mockRestore();
    }
  });

  it.each(["all", "configured", "default"] as const)(
    "keeps case-distinct and literal provider-prefixed identities in the %s view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "fixture", id: "MixedCase", name: "Large", contextWindow: 64_000 },
        { provider: "fixture", id: "mixedcase", name: "Small", contextWindow: 16_000 },
        { provider: "fixture", id: "fixture/MixedCase", name: "Namespaced", contextWindow: 32_000 },
      ];
      const result = await resolveLogicalVisibleModelCatalog({
        cfg: { agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } } },
        catalog,
        defaultProvider: "fixture",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: async () =>
          resolveLogicalModelCatalogEntryState({
            evaluation: { availability: true, routeResolution: null },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });

      expect(result).toEqual(expect.arrayContaining(catalog));
      expect(result).toHaveLength(3);
    },
  );

  it("keeps a literal catalog suffix distinct from its base model", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "fixture", id: "reader", name: "Base" },
      { provider: "fixture", id: "reader@variant", name: "Literal variant" },
    ];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {},
      catalog,
      defaultProvider: "fixture",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: { availability: true, routeResolution: null },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
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

  const evaluateAvailableEntry = async () =>
    resolveLogicalModelCatalogEntryState({
      evaluation: { availability: true, routeResolution: null },
      routePolicy: openAIModelCatalogRoutePolicy,
    });

  it.each(["default", "configured"] as const)(
    "hides deprecated and disabled rows from the %s picker view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "demo", id: "current", name: "Current", status: "available" },
        { provider: "demo", id: "old", name: "Old", status: "deprecated" },
        { provider: "demo", id: "off", name: "Off", status: "disabled" },
      ];

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog,
        defaultProvider: "demo",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      });

      expect(result.map((entry) => entry.id)).toEqual(["current"]);
    },
  );

  it("keeps deprecated and disabled rows in the all inventory", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "old", name: "Old", status: "deprecated" },
      { provider: "demo", id: "off", name: "Off", status: "disabled" },
    ];

    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "demo",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["off", "old"]);
  });

  it("preserves provider-owned strongest-first order through route projection", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", providerOrder: 3 },
      { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", providerOrder: 2 },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerOrder: 0 },
      { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", providerOrder: 1 },
    ];

    const result = await resolveLogicalVisibleModelCatalog({
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
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

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["alias-key", "primary"]);
  });

  it.each(["all", "default", "configured"] as const)(
    "dedupes physical routes after selected-route projection in the %s view",
    async (view) => {
      const catalog = [
        { ...platform, alias: "platform" },
        { ...chatGPT, alias: "selected" },
      ];
      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog,
        defaultProvider: "openai",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: async () =>
          resolveLogicalModelCatalogEntryState({
            evaluation: {
              availability: true,
              routeResolution: { kind: "routes", routes: [selectedRoute] },
              selectedRoute,
            },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });

      expect(result).toEqual([
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "ChatGPT GPT-5.5",
          alias: view === "all" ? "platform" : "selected",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 400_000,
          reasoning: false,
          input: ["text"],
        },
      ]);
    },
  );

  it.each([
    ["deprecated", []],
    ["available", ["gpt-5.5"]],
  ] as const)("uses the selected route's %s lifecycle status", async (status, expectedIds) => {
    const platformAvailable = { ...platform, status: "available" as const };
    const chatGPTSelected = { ...chatGPT, status };
    const catalog = [platformAvailable, chatGPTSelected];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      routeVariants: catalog,
      defaultProvider: "openai",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result.map((entry) => entry.id)).toEqual(expectedIds);
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog: [platform],
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: false,
            routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([{ provider: "openai", id: "gpt-5.5", name: "Platform GPT-5.5" }]);
  });

  it.each([false, true])(
    "projects one canonical nano row from reversed physical variants (reverse=%s)",
    async (reverse) => {
      const platformNano: ModelCatalogEntry = {
        ...platform,
        id: "gpt-5.4-nano",
        name: "Platform Nano",
      };
      const chatGPTNano: ModelCatalogEntry = {
        ...chatGPT,
        id: "gpt-5.4-nano",
        name: "ChatGPT Nano",
      };
      const routeVariants = reverse ? [platformNano, chatGPTNano] : [chatGPTNano, platformNano];
      const evaluateEntry = vi.fn(
        async (_entry: ModelCatalogEntry, _variants: readonly ModelCatalogEntry[]) =>
          resolveLogicalModelCatalogEntryState({
            evaluation: {
              availability: true,
              routeResolution: { kind: "routes", routes: [selectedRoute] },
              selectedRoute,
            },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      );

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog: [platformNano],
        routeVariants,
        defaultProvider: "openai",
        view: "all",
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry,
      });

      expect(evaluateEntry).toHaveBeenCalledOnce();
      expect(evaluateEntry.mock.calls[0]?.[1]).toEqual(routeVariants);
      expect(result).toEqual([
        {
          provider: "openai",
          id: "gpt-5.4-nano",
          name: "ChatGPT Nano",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 400_000,
          reasoning: false,
          input: ["text"],
        },
      ]);
    },
  );
});
