import { beforeAll, describe, expect, it } from "vitest";

let buildOpenAICodexProviderPlugin: typeof import("../../extensions/openai/openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai-codex implicit provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } =
      await import("../../extensions/openai/openai-codex-provider.js"));
  });

  it("normalizes generated openai-codex rows back to the Codex transport", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const normalized = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 100_000,
      },
    } as never);

    expect(normalized).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    });
  });

  it("preserves an existing Codex baseUrl for explicit openai-codex config", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const normalized = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 100_000,
      },
    } as never);

    expect(normalized).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    });
  });
});
