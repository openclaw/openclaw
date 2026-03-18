import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

describe("buildOpenAIProvider", () => {
  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            id,
            name: "GPT-5 mini",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 128_000,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            id,
            name: "GPT-5 nano",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
    });

    expect(mini).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(nano).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it("surfaces gpt-5.4 mini and nano in xhigh and augmented catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.supportsXHighThinking?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      } as never),
    ).toBe(true);
    expect(
      provider.supportsXHighThinking?.({
        provider: "openai",
        modelId: "gpt-5.4-nano",
      } as never),
    ).toBe(true);

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
      ],
    } as never);

    expect(entries).toContainEqual({
      provider: "openai",
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
    });
    expect(entries).toContainEqual({
      provider: "openai",
      id: "gpt-5.4-nano",
      name: "gpt-5.4-nano",
    });
  });
});
