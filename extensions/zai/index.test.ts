import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../src/test-utils/provider-usage-fetch.js";
import zaiPlugin from "./index.js";

const registerProvider = () => registerSingleProviderPlugin(zaiPlugin);

describe("zai plugin", () => {
  it("owns glm-5 forward-compat resolution", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "zai",
      modelId: "glm-5",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "glm-4.7"
            ? {
                id,
                name: id,
                api: "openai-completions",
                provider: "zai",
                baseUrl: "https://api.z.ai/api/paas/v4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 202_752,
                maxTokens: 16_384,
              }
            : null,
      } as never,
    });

    expect(model).toMatchObject({
      id: "glm-5",
      provider: "zai",
      api: "openai-completions",
      reasoning: true,
    });
  });

  it("owns usage auth resolution", async () => {
    const provider = registerProvider();
    await expect(
      provider.resolveUsageAuth?.({
        config: {} as never,
        env: {
          ZAI_API_KEY: "env-zai-token",
        } as NodeJS.ProcessEnv,
        provider: "zai",
        resolveApiKeyFromConfigAndStore: () => "env-zai-token",
        resolveOAuthToken: async () => null,
      }),
    ).resolves.toEqual({
      token: "env-zai-token",
    });
  });

  it("owns usage snapshot fetching", async () => {
    const provider = registerProvider();
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.z.ai/api/monitor/usage/quota/limit")) {
        return makeResponse(200, {
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                percentage: 25,
                unit: 3,
                number: 6,
                nextResetTime: "2026-01-07T06:00:00Z",
              },
            ],
          },
        });
      }
      return makeResponse(404, "not found");
    });

    await expect(
      provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "zai",
        token: "env-zai-token",
        timeoutMs: 5_000,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [{ label: "Tokens (6h)", usedPercent: 25, resetAt: 1_767_765_600_000 }],
      plan: "Pro",
    });
  });
});
