import { calculateCost, type Model } from "openclaw/plugin-sdk/llm";
import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { buildMoonshotProvider } from "./api.js";

useProviderCatalogMetadata(new URL(".", import.meta.url));

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
});
