/**
 * Regression coverage for model catalog visibility filtering.
 * Keeps provider/model allow and hide rules aligned with catalog row metadata.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredModelEntries } from "./configured-model-entries.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

describe("resolveLogicalVisibleModelCatalog", () => {
  it.each(["all", "configured", "default"] as const)(
    "keeps case-distinct and literal provider-prefixed identities in the %s view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "fixture", id: "MixedCase", name: "Large", contextWindow: 64_000 },
        { provider: "fixture", id: "mixedcase", name: "Small", contextWindow: 16_000 },
        { provider: "fixture", id: "fixture/MixedCase", name: "Namespaced", contextWindow: 32_000 },
      ];
      const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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

  it.each([
    [["openai/*"], ["openai/atlas", "openai/beta", "other/primary"], 1, true],
    [["openai/atlas"], ["openai/atlas", "other/primary"], 2, true],
    [["openai/missing"], ["other/primary"], 3, true],
    [["openai/missing"], [], 4, false],
    [["openai/atlas"], ["openai/atlas", "other/fallback"], 2, true, "agent:main:subagent:worker"],
    [["openai/atlas"], ["openai/atlas", "other/primary"], 2, true, "agent:main:main"],
    [
      ["openai/*", "other/fallback"],
      ["openai/atlas", "openai/beta", "other/fallback", "other/primary"],
      0,
      true,
    ],
  ] as const)(
    "publishes listed models and the configured primary for %j",
    async (allow, expected, hiddenCount, configuredPrimary, sessionKey?: string) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "openai", id: "atlas", name: "Atlas" },
        { provider: "openai", id: "beta", name: "Beta" },
        { provider: "other", id: "primary", name: "Primary" },
        { provider: "other", id: "fallback", name: "Fallback" },
      ];
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            subagents: { model: "other/fallback" },
            model: {
              ...(configuredPrimary ? { primary: "other/primary" } : {}),
              fallbacks: ["other/fallback"],
            },
            modelPolicy: { allow: [...allow] },
          },
        },
      };
      const { entries: result, allowList } = await resolveLogicalVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: "other",
        defaultModel: "primary",
        agentId: "main",
        sessionKey,
        selectedModel: { provider: "other", model: "fallback" },
        view: "configured",
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      });
      expect(result.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(expected);
      expect(allowList).toMatchObject({
        hiddenCount,
        settingsPath: "agents.defaults.modelPolicy.allow",
      });
      if (sessionKey) {
        const subagent = sessionKey === "agent:main:subagent:worker";
        expect(allowList?.selectedModelBlocked).toBe(!subagent);
        expect(
          resolveConfiguredModelEntries({ cfg, agentId: "main", sessionKey })
            .byKey.get("other/fallback")
            ?.tags.has("default"),
        ).toBe(subagent);
      }
    },
  );

  it.each(["default", "configured"] as const)(
    "hides deprecated and disabled rows from the %s picker view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "demo", id: "current", name: "Current", status: "available" },
        { provider: "demo", id: "old", name: "Old", status: "deprecated" },
        { provider: "demo", id: "off", name: "Off", status: "disabled" },
      ];

      const { entries: result } = await resolveLogicalVisibleModelCatalog({
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

    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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

    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
          modelPolicy: { allow: ["demo/*"] },
          models: { "demo/alias-key": { alias: "legacy" } },
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

    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
      const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
    const { entries: result } = await resolveLogicalVisibleModelCatalog({
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

      const { entries: result } = await resolveLogicalVisibleModelCatalog({
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
