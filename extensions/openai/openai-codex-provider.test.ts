import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai codex provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  });

  it("falls back to the cached credential when accountId extraction fails", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });

  it("rethrows unrelated refresh failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow("invalid_grant");
  });

  it("merges refreshed oauth credentials", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
      email: "user@example.com",
      displayName: "User",
    };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "next-access",
      refresh: "next-refresh",
      expires: expect.any(Number),
    });
  });

  it("returns deprecated-profile doctor guidance for legacy Codex CLI ids", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildAuthDoctorHint?.({
        provider: "openai-codex",
        profileId: "openai-codex:codex-cli",
        config: undefined,
        store: { version: 1, profiles: {} },
      }),
    ).toBe(
      "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.",
    );
  });

  it("resolves gpt-5.4-mini from template model", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai-codex") {
          return null;
        }
        if (id === "gpt-5.3-codex") {
          return {
            id,
            name: "GPT-5.3 Codex",
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const resolved = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });

    expect(resolved).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      // explicit runtime metadata overrides template values
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
  });

  it("falls back to defaults when no template is found for gpt-5.4-mini", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const registry = {
      find() {
        return null;
      },
    };

    const resolved = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });

    expect(resolved).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
  });

  it("surfaces gpt-5.4-mini in augmented catalog", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          provider: "openai-codex",
          id: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
        },
      ],
    } as never);

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai-codex",
          id: "gpt-5.4-mini",
          name: "gpt-5.4-mini",
        }),
      ]),
    );
  });

  it("recognizes gpt-5.4-mini in supportsXHighThinking", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.supportsXHighThinking?.({
        provider: "openai-codex",
        modelId: "gpt-5.4-mini",
      } as never),
    ).toBe(true);
  });

  it("recognizes gpt-5.4-mini in isModernModelRef", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.4-mini",
      } as never),
    ).toBe(true);
  });
});
