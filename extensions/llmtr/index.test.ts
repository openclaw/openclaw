// LLMTR tests cover plugin registration and model discovery filtering.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCachedLiveProviderModelRows = vi.fn();

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async () => {
  // Keep the real LiveModelCatalogHttpError: models.ts branches on `instanceof`.
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")
  >("openclaw/plugin-sdk/provider-catalog-live-runtime");
  return { ...actual, getCachedLiveProviderModelRows };
});

const { discoverLlmtrModels, LLMTR_BASE_URL } = await import("./models.js");
const plugin = (await import("./index.js")).default;

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

function modelRow(id: string, operations: string[]) {
  return { id, object: "model", owned_by: id.split("/")[0], supported_operations: operations };
}

describe("llmtr provider plugin", () => {
  beforeEach(() => {
    getCachedLiveProviderModelRows.mockReset();
  });

  it("registers LLMTR as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("llmtr");
    expect(provider.envVars).toEqual(["LLMTR_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe(LLMTR_BASE_URL);

    const ids = catalogProvider.models?.map((model) => model.id) ?? [];
    // Bundled catalog ships Turkey-hosted models plus a global selection.
    // Turkey-hosted routes are literally `llmtr/<name>` upstream, so the vendor
    // prefix must survive normalization even though it repeats the provider id
    // (`modelKey` collapses the display ref back to `llmtr/trendyol-7b`).
    expect(ids).toContain("llmtr/trendyol-7b");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });

  it("drops discovered models that cannot serve chat completions", async () => {
    getCachedLiveProviderModelRows.mockResolvedValue([
      modelRow("llmtr/trendyol-7b", ["CHAT_COMPLETIONS"]),
      modelRow("openai/gpt-5.5", ["RESPONSES"]),
      modelRow("llmtr/embeddinggemma-300m", ["EMBEDDINGS"]),
      modelRow("google/gemini-3.5-flash", ["CHAT_COMPLETIONS", "RESPONSES"]),
    ]);

    const ids = (await discoverLlmtrModels("key")).map((model) => model.id);

    expect(ids).toEqual(["llmtr/trendyol-7b", "google/gemini-3.5-flash"]);
  });

  it("keeps curated metadata for discovered models and defaults the rest", async () => {
    getCachedLiveProviderModelRows.mockResolvedValue([
      modelRow("anthropic/claude-sonnet-5", ["CHAT_COMPLETIONS"]),
      modelRow("nvidia/nemotron-3-nano-30b-a3b", ["CHAT_COMPLETIONS"]),
    ]);

    const models = await discoverLlmtrModels("key");
    const curated = models.find((model) => model.id === "anthropic/claude-sonnet-5");
    const discovered = models.find((model) => model.id === "nvidia/nemotron-3-nano-30b-a3b");

    // The gateway publishes no context metadata, so curated entries must win.
    expect(curated?.contextWindow).toBe(200000);
    expect(curated?.input).toContain("image");
    expect(discovered?.contextWindow).toBe(32768);
    // LLMTR omits usage from streamed responses; both paths must carry the flag.
    expect(curated?.compat?.supportsUsageInStreaming).toBe(false);
    expect(discovered?.compat?.supportsUsageInStreaming).toBe(false);
  });

  it("falls back to the bundled catalog when discovery fails", async () => {
    getCachedLiveProviderModelRows.mockRejectedValue(new Error("network down"));

    const ids = (await discoverLlmtrModels()).map((model) => model.id);

    expect(ids).toContain("llmtr/trendyol-7b");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });
});
