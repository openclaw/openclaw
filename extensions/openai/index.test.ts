import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import openAIPlugin from "./index.js";

function registerProvider(): ProviderPlugin {
  let provider: ProviderPlugin | undefined;
  openAIPlugin.register({
    registerProvider(nextProvider: ProviderPlugin) {
      provider = nextProvider;
    },
  } as never);
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

describe("openai plugin", () => {
  it("owns openai gpt-5.4 forward-compat resolution", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-pro",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.2-pro"
            ? {
                id,
                name: id,
                api: "openai-responses",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              }
            : null,
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4-pro",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("owns direct openai transport normalization", () => {
    const provider = registerProvider();
    expect(
      provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-completions",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_050_000,
          maxTokens: 128_000,
        },
      }),
    ).toMatchObject({
      api: "openai-responses",
    });
  });
});
