import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
// Prepared OpenRouter rows must follow capability-cache refreshes for
// catalog-derived effort metadata while operator declarations keep winning.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import { beforeEach, describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";
import { buildOpenrouterLiveProvider } from "./provider-catalog.js";

const loadedCapabilities = vi.hoisted(
  () =>
    new Map<
      string,
      | {
          compat?: { supportedReasoningEfforts?: string[] };
          thinkingLevelMap?: { off: null };
        }
      | undefined
    >(),
);

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderStreamFamily>()),
  getLoadedOpenRouterModelCapabilities: (modelId: string) => loadedCapabilities.get(modelId),
}));

const MODEL_ID = "acme/effort-model";

function effortModelResponse(efforts: string[]): Response {
  return Response.json({
    data: [
      {
        id: MODEL_ID,
        name: "Effort Model",
        architecture: { modality: "text->text" },
        supported_parameters: ["reasoning", "tools"],
        reasoning: { supported_efforts: efforts, mandatory: true },
      },
    ],
  });
}

describe("OpenRouter catalog-derived thinking efforts", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    loadedCapabilities.clear();
  });

  it("marks prepared rows on the canonical route and follows refreshed capabilities", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: effortModelResponse(["xhigh", "high", "medium", "low"]),
      finalUrl: url,
      release: async () => undefined,
    }));

    const catalog = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      fetchGuard,
    });
    const row = catalog.models.find((model) => model.id === MODEL_ID);
    expect(row).toBeDefined();
    // Discovery still copies the upstream catalog's effort metadata.
    expect(row?.compat?.supportedReasoningEfforts).toEqual(["xhigh", "high", "medium", "low"]);
    expect(row?.thinkingLevelMap).toEqual({ off: null });
    // ...but marks it as catalog-derived so consumers can follow refreshes.
    expect(row?.catalogReasoningEfforts).toBe(true);

    // The capability cache refreshes later (missing-model load) without the
    // gateway restarting; the prepared row still advertises the old level.
    loadedCapabilities.set(MODEL_ID, {
      compat: { supportedReasoningEfforts: ["high", "medium", "low"] },
      thinkingLevelMap: { off: null },
    });

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const context: ProviderDefaultThinkingPolicyContext = {
      provider: "openrouter",
      modelId: MODEL_ID,
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
      reasoning: row?.reasoning,
      compat: row?.compat,
      thinkingLevelMap: row?.thinkingLevelMap,
      ...(row?.catalogReasoningEfforts ? { catalogReasoningEfforts: true } : {}),
    };
    expect(provider.resolveThinkingProfile?.(context)?.levels.map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps the prepared row's own efforts while capabilities are not loaded", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: effortModelResponse(["xhigh", "high", "medium", "low"]),
      finalUrl: url,
      release: async () => undefined,
    }));
    const catalog = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      fetchGuard,
    });
    const row = catalog.models.find((model) => model.id === MODEL_ID);

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const context: ProviderDefaultThinkingPolicyContext = {
      provider: "openrouter",
      modelId: MODEL_ID,
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
      reasoning: row?.reasoning,
      compat: row?.compat,
      thinkingLevelMap: row?.thinkingLevelMap,
      ...(row?.catalogReasoningEfforts ? { catalogReasoningEfforts: true } : {}),
    };
    // A cold capability cache keeps the prepared row's own snapshot.
    expect(provider.resolveThinkingProfile?.(context)?.levels.map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps custom-route rows owning their discovered efforts", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: effortModelResponse(["xhigh", "high"]),
      finalUrl: url,
      release: async () => undefined,
    }));
    const catalog = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      baseUrl: "https://private.example.invalid/v1",
      fetchGuard,
    });
    const row = catalog.models.find((model) => model.id === MODEL_ID);
    expect(row?.catalogReasoningEfforts).toBeUndefined();

    loadedCapabilities.set(MODEL_ID, {
      compat: { supportedReasoningEfforts: ["high"] },
      thinkingLevelMap: { off: null },
    });

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const profile = provider.resolveThinkingProfile?.({
      provider: "openrouter",
      modelId: MODEL_ID,
      api: "openai-completions",
      baseUrl: "https://private.example.invalid/v1",
      reasoning: row?.reasoning,
      compat: row?.compat,
      thinkingLevelMap: row?.thinkingLevelMap,
    });
    // The proxy catalog's discovered efforts stay authoritative on its route.
    expect(profile?.levels.map((level) => level.id)).toEqual(["high", "xhigh"]);
  });

  it("keeps operator-authored thinking maps even with a warm capability cache", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: effortModelResponse(["xhigh", "high", "medium", "low"]),
      finalUrl: url,
      release: async () => undefined,
    }));
    const catalog = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      fetchGuard,
    });
    const row = catalog.models.find((model) => model.id === MODEL_ID);

    // A warm cache refresh advertises a different generation.
    loadedCapabilities.set(MODEL_ID, {
      compat: { supportedReasoningEfforts: ["medium", "low"] },
      thinkingLevelMap: { off: null },
    });

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    // The prepared row was projected with an operator-authored thinking map;
    // route projection clears the catalog provenance marker for such rows.
    const authoredContext: ProviderDefaultThinkingPolicyContext = {
      provider: "openrouter",
      modelId: MODEL_ID,
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
      reasoning: row?.reasoning,
      compat: row?.compat,
      thinkingLevelMap: { off: null, low: "high", high: "high" },
    };
    const authoredProfile = provider.resolveThinkingProfile?.(authoredContext);
    // The authored row keeps its own discovered efforts; the cached
    // generation ["medium", "low"] cannot replace them.
    expect(authoredProfile?.levels.map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    // Counterfactual: the same row still carrying the marker would be
    // clobbered onto the cached generation, dropping authored "high"/"xhigh".
    const markedProfile = provider.resolveThinkingProfile?.({
      ...authoredContext,
      catalogReasoningEfforts: true,
    });
    expect(markedProfile?.levels.map((level) => level.id)).toEqual(["low", "medium"]);
  });
});
