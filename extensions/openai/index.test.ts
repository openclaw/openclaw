import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import openAIPlugin from "./index.js";

function registerProviders(): ProviderPlugin[] {
  const providers: ProviderPlugin[] = [];
  openAIPlugin.register({
    registerProvider(nextProvider: ProviderPlugin) {
      providers.push(nextProvider);
    },
  } as never);
  return providers;
}

function requireProvider(id: string): ProviderPlugin {
  const provider = registerProviders().find((entry) => entry.id === id);
  if (!provider) {
    throw new Error(`provider registration missing for ${id}`);
  }
  return provider;
}

describe("openai plugin", () => {
  it("registers openai and openai-codex providers from one extension", () => {
    expect(registerProviders().map((provider) => provider.id)).toEqual(["openai", "openai-codex"]);
  });

  it("owns openai gpt-5.4 forward-compat resolution", () => {
    const provider = requireProvider("openai");
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
    const provider = requireProvider("openai");
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

  it("owns codex-only missing-auth hints and Spark suppression", () => {
    const provider = requireProvider("openai");
    expect(
      provider.buildMissingAuthMessage?.({
        env: {} as NodeJS.ProcessEnv,
        provider: "openai",
        listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
      }),
    ).toContain("openai-codex/gpt-5.4");
    expect(
      provider.suppressBuiltInModel?.({
        env: {} as NodeJS.ProcessEnv,
        provider: "azure-openai-responses",
        modelId: "gpt-5.3-codex-spark",
      }),
    ).toMatchObject({
      suppress: true,
    });
  });
});
