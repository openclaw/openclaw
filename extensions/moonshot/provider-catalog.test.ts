import { calculateCost, type Model } from "openclaw/plugin-sdk/llm";
import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  applyMoonshotNativeStreamingUsageCompat,
  buildMoonshotProvider,
  MOONSHOT_CN_BASE_URL,
} from "./api.js";

useProviderCatalogMetadata(new URL(".", import.meta.url));

type MoonshotProvider = ReturnType<typeof buildMoonshotProvider>;
type MoonshotModel = MoonshotProvider["models"][number];

function requireFirstMoonshotModel(provider: MoonshotProvider): MoonshotModel {
  const model = provider.models[0];
  if (!model) {
    throw new Error("expected first Moonshot model");
  }
  return model;
}

describe("moonshot provider catalog", () => {
  it("prices K3 default five-minute cache writes separately from cache reads", () => {
    const provider = buildMoonshotProvider();
    const entry = provider.models.find((model) => model.id === "kimi-k3");
    if (!entry) {
      throw new Error("expected Kimi K3 catalog model");
    }
    const model: Model<"openai-completions"> = {
      ...entry,
      input: ["text"],
      provider: "moonshot",
      api: "openai-completions",
      baseUrl: provider.baseUrl,
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 1000,
      cacheWrite: 1000,
      totalTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const cost = calculateCost(model, usage);
    expect(cost.cacheRead).toBeCloseTo(0.0003, 10);
    expect(cost.cacheWrite).toBeCloseTo(0.003, 10);
    expect(cost.total).toBeCloseTo(0.0033, 10);
  });

  it("opts native Moonshot baseUrls into streaming usage only inside the extension", () => {
    const defaultProvider = applyMoonshotNativeStreamingUsageCompat(buildMoonshotProvider());
    expect(requireFirstMoonshotModel(defaultProvider).compat?.supportsUsageInStreaming).toBe(true);

    const cnProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    });
    expect(requireFirstMoonshotModel(cnProvider).compat?.supportsUsageInStreaming).toBe(true);

    const customProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      "supportsUsageInStreaming" in (requireFirstMoonshotModel(customProvider).compat ?? {}),
    ).toBe(false);
  });
});
