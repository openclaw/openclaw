import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRemoteCatalogUrl } from "../model-catalog/remote-config.js";
import { withRemoteModelCatalogSnapshot } from "../model-catalog/remote-overlay.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicySurface from "../plugins/provider-policy-surface.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { subscriptionRoute as selectedRoute } from "./model-auth-availability.test-support.js";
import { providerConfig, row } from "./model-catalog-fixtures.test-support.js";
import {
  prepareLogicalVisibleModelCatalog,
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const entryState = (
  evaluation: ModelAuthAvailabilityEvaluation = { availability: true, routeResolution: null },
) => resolveLogicalModelCatalogEntryState({ evaluation });
type VisibleParams = Parameters<typeof resolveLogicalVisibleModelCatalog>[0];
const visible = (catalog: ModelCatalogEntry[], params: Partial<VisibleParams> = {}) =>
  resolveLogicalVisibleModelCatalog({
    cfg: {},
    catalog,
    defaultProvider: "fixture",
    view: "all",
    evaluateEntry: async () => entryState(),
    ...params,
  });

describe("resolveLogicalVisibleModelCatalog", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps the selected model ahead of curated and live rows in a large catalog", async () => {
    const catalog = Array.from({ length: 300 }, (_, index) =>
      row("fixture", `model-${String(index).padStart(3, "0")}`, {
        name: `Model ${index}`,
        providerOrder: index,
      }),
    );
    const result = await visible(catalog, {
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
    const catalog = [
      ...["a-0", "a-1", "a-2", "a-3", "a-4"].map((id, providerOrder) =>
        row("alpha", id, { providerOrder }),
      ),
      row("beta", "b-0", { providerOrder: 0 }),
      row("beta", "b-1", { providerOrder: 1 }),
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
        visible(catalog, {
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
      const entry: ModelCatalogEntry = {
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
      };
      if (scenario === "projected API") {
        const { provider: _provider, ...model } = makeProviderModelFixture<typeof api>({
          id: entry.id,
          name: entry.name,
          provider: entry.provider,
          api,
          baseUrl,
        });
        cfg.models = providerConfig("personal", { api, baseUrl, models: [model] }).models;
      }
      const route = {
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      };
      const projected = scenario === "projected API";
      const result = await visible([entry], {
        cfg,
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
      expect(result.map((item) => item.id)).toEqual(scenario === "opaque runtime" ? ["auto"] : []);
    },
  );

  it("rereads later row identities and policy after entry preparation suspends", async () => {
    const first = row("fixture", "first", { name: "First" });
    const later = row("fixture", "vendor/first", { name: "Later" });
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
    const preparedEntries: ModelCatalogEntry[] = [];
    const read = await prepareLogicalVisibleModelCatalog({
      cfg: {},
      catalog,
      policy,
      defaultProvider: "fixture",
      view: "all",
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
  });

  it.each([
    {
      name: "case-distinct and provider-prefixed",
      view: "default" as const,
      cfg: { agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } } },
      catalog: [
        row("fixture", "MixedCase", { name: "Large", contextWindow: 64_000 }),
        row("fixture", "mixedcase", { name: "Small", contextWindow: 16_000 }),
        row("fixture", "fixture/MixedCase", { name: "Namespaced", contextWindow: 32_000 }),
      ],
    },
    {
      name: "literal suffixed",
      view: "all" as const,
      cfg: {},
      catalog: [
        row("fixture", "reader", { name: "Base" }),
        row("fixture", "reader@variant", { name: "Literal variant" }),
      ],
    },
  ])("keeps $name identities distinct", async ({ catalog, view, cfg }) => {
    const result = await visible(catalog, { view, cfg });
    expect(result).toEqual(expect.arrayContaining(catalog));
    expect(result).toHaveLength(catalog.length);
  });

  const platform = row("openai", "gpt-5.5", {
    name: "Platform GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
  });
  const chatGPT = row("openai", "gpt-5.5", {
    name: "ChatGPT GPT-5.5",
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 400_000,
    reasoning: false,
    input: ["text"],
  });

  const evaluateSelectedEntry = async () =>
    entryState({
      availability: true,
      routeResolution: { kind: "routes", routes: [selectedRoute] },
      selectedRoute,
    });

  it("preserves provider-owned strongest-first order through route projection", async () => {
    const catalog = [
      row("openai", "gpt-5.4", { name: "GPT-5.4", providerOrder: 3 }),
      row("openai", "gpt-5.6-luna", { name: "GPT-5.6 Luna", providerOrder: 2 }),
      row("openai", "gpt-5.6-sol", { name: "GPT-5.6 Sol", providerOrder: 0 }),
      row("openai", "gpt-5.6-terra", { name: "GPT-5.6 Terra", providerOrder: 1 }),
    ];

    const result = await visible(catalog, {
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
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

    const result = await visible(catalog, {
      cfg,
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
    const result = await visible(catalog, {
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
    const result = await visible(catalog, {
      routeVariants: catalog,
      defaultProvider: "openai",
      view: undefined,
      evaluateEntry: evaluateSelectedEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual([]);
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const result = await visible([platform], {
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
