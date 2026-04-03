import { describe, expect, it, vi } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

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
      contextWindow: 400_000,
      maxTokens: 128_000,
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

    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "gpt-5.4-mini",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "gpt-5.4-nano",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
      }),
    );
  });

  it("keeps modern live selection on OpenAI 5.2+ and Codex 5.2+", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.0",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);

    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex-max",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.2-codex",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
  });

  it("falls back to cached codex oauth credentials on accountId extraction failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };

    refreshOpenAICodexTokenMock.mockReset();
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });
});
