import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
// Prepared OpenRouter rows must follow capability-cache refreshes for
// catalog-derived effort metadata while operator declarations keep winning.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const CANONICAL_BASE_URL = "https://openrouter.ai/api/v1";

function catalogFetch(efforts: string[]) {
  return vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url }) => ({
    response: Response.json({
      data: [
        {
          id: MODEL_ID,
          name: "Effort Model",
          architecture: { modality: "text->text" },
          supported_parameters: ["reasoning", "tools"],
          reasoning: { supported_efforts: efforts, mandatory: true },
        },
      ],
    }),
    finalUrl: url,
    release: async () => undefined,
  }));
}

type DiscoveredRow = NonNullable<
  Awaited<ReturnType<typeof buildOpenrouterLiveProvider>>["models"]
>[number];

function thinkingContext(
  row: DiscoveredRow,
  baseUrl: string,
): ProviderDefaultThinkingPolicyContext {
  return {
    provider: "openrouter",
    modelId: MODEL_ID,
    api: "openai-completions",
    baseUrl,
    reasoning: row.reasoning,
    compat: row.compat,
    thinkingLevelMap: row.thinkingLevelMap,
    ...(row.catalogReasoningEfforts ? { catalogReasoningEfforts: true } : {}),
  };
}

describe("OpenRouter catalog-derived thinking efforts", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    loadedCapabilities.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("marks prepared rows on the canonical route and follows refreshed capabilities", async () => {
    catalogFetch(["xhigh", "high", "medium", "low"]);
    const catalog = await buildOpenrouterLiveProvider({ apiKey: "OPENROUTER_API_KEY" });
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
    const context = thinkingContext(row!, catalog.baseUrl ?? CANONICAL_BASE_URL);
    expect(provider.resolveThinkingProfile?.(context)?.levels.map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps the prepared row's own efforts while capabilities are not loaded", async () => {
    catalogFetch(["xhigh", "high", "medium", "low"]);
    const catalog = await buildOpenrouterLiveProvider({ apiKey: "OPENROUTER_API_KEY" });
    const row = catalog.models.find((model) => model.id === MODEL_ID);

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const context = thinkingContext(row!, catalog.baseUrl ?? CANONICAL_BASE_URL);
    // A cold capability cache keeps the prepared row's own snapshot.
    expect(provider.resolveThinkingProfile?.(context)?.levels.map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps custom-route rows owning their discovered efforts", async () => {
    catalogFetch(["xhigh", "high"]);
    const catalog = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      baseUrl: "https://private.example.invalid/v1",
    });
    const row = catalog.models.find((model) => model.id === MODEL_ID);
    expect(row?.catalogReasoningEfforts).toBeUndefined();

    loadedCapabilities.set(MODEL_ID, {
      compat: { supportedReasoningEfforts: ["high"] },
      thinkingLevelMap: { off: null },
    });

    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const profile = provider.resolveThinkingProfile?.(
      thinkingContext(row!, catalog.baseUrl ?? "https://private.example.invalid/v1"),
    );
    // The proxy catalog's discovered efforts stay authoritative on its route.
    expect(profile?.levels.map((level) => level.id)).toEqual(["high", "xhigh"]);
  });
});
