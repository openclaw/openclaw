import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../src/test-utils/provider-usage-fetch.js";
import anthropicPlugin from "./index.js";

const registerProvider = () => registerSingleProviderPlugin(anthropicPlugin);

describe("anthropic plugin", () => {
  it("owns anthropic 4.6 forward-compat resolution", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-sonnet-4.6-20260219",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "claude-sonnet-4.5-20260219"
            ? {
                id,
                name: id,
                api: "anthropic-messages",
                provider: "anthropic",
                baseUrl: "https://api.anthropic.com",
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
      id: "claude-sonnet-4.6-20260219",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("owns usage auth resolution", async () => {
    const provider = registerProvider();
    await expect(
      provider.resolveUsageAuth?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "anthropic",
        resolveApiKeyFromConfigAndStore: () => undefined,
        resolveOAuthToken: async () => ({
          token: "anthropic-oauth-token",
        }),
      }),
    ).resolves.toEqual({
      token: "anthropic-oauth-token",
    });
  });

  it("owns usage snapshot fetching", async () => {
    const provider = registerProvider();
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.anthropic.com/api/oauth/usage")) {
        return makeResponse(200, {
          five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
          seven_day: { utilization: 35, resets_at: "2026-01-09T01:00:00Z" },
        });
      }
      return makeResponse(404, "not found");
    });

    const snapshot = await provider.fetchUsageSnapshot?.({
      config: {} as never,
      env: {} as NodeJS.ProcessEnv,
      provider: "anthropic",
      token: "anthropic-oauth-token",
      timeoutMs: 5_000,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      provider: "anthropic",
      displayName: "Claude",
      windows: [
        { label: "5h", usedPercent: 20, resetAt: Date.parse("2026-01-07T01:00:00Z") },
        { label: "Week", usedPercent: 35, resetAt: Date.parse("2026-01-09T01:00:00Z") },
      ],
    });
  });
});
