import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../src/test-utils/provider-usage-fetch.js";
import openAICodexPlugin from "./index.js";

function registerProvider(): ProviderPlugin {
  let provider: ProviderPlugin | undefined;
  openAICodexPlugin.register({
    registerProvider(nextProvider: ProviderPlugin) {
      provider = nextProvider;
    },
  } as never);
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

describe("openai-codex plugin", () => {
  it("owns forward-compat codex models", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.2-codex"
            ? {
                id,
                name: id,
                api: "openai-codex-responses",
                provider: "openai-codex",
                baseUrl: "https://chatgpt.com/backend-api",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              }
            : null,
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      provider: "openai-codex",
      api: "openai-codex-responses",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("owns codex transport defaults", () => {
    const provider = registerProvider();
    expect(
      provider.prepareExtraParams?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        extraParams: { temperature: 0.2 },
      }),
    ).toEqual({
      temperature: 0.2,
      transport: "auto",
    });
  });

  it("owns usage snapshot fetching", async () => {
    const provider = registerProvider();
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("chatgpt.com/backend-api/wham/usage")) {
        return makeResponse(200, {
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 10800, reset_at: 1_705_000 },
          },
          plan_type: "Plus",
        });
      }
      return makeResponse(404, "not found");
    });

    await expect(
      provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "openai-codex",
        token: "codex-token",
        accountId: "acc-1",
        timeoutMs: 5_000,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      provider: "openai-codex",
      displayName: "Codex",
      windows: [{ label: "3h", usedPercent: 12, resetAt: 1_705_000_000 }],
      plan: "Plus",
    });
  });
});
