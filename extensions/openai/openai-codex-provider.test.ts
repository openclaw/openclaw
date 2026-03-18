import { describe, expect, it } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";

describe("buildOpenAICodexProviderPlugin", () => {
  it("resolves gpt-5.4-mini from the codex mini template", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai-codex" || id !== "gpt-5.1-codex-mini") {
          return null;
        }
        return {
          id,
          name: "GPT-5.1 Codex Mini",
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 64_000,
        };
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });

    expect(mini).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 128_000,
      maxTokens: 128_000,
    });
  });

  it("uses explicit gpt-5.4-mini limits on the no-template fallback path", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const mini = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: {
        find: () => null,
      } as never,
    });

    expect(mini).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 128_000,
      maxTokens: 128_000,
    });
  });

  it("surfaces gpt-5.4-mini in codex augmented catalog metadata", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [{ provider: "openai-codex", id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" }],
    } as never);

    expect(entries).toContainEqual({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
    });
    expect(
      provider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.4-mini",
      } as never),
    ).toBe(true);
  });
});
