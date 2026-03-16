import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../src/test-utils/provider-usage-fetch.js";
import googlePlugin from "./index.js";

function registerGooglePlugin(): {
  provider: ProviderPlugin;
  webSearchProvider: {
    id: string;
    envVars: string[];
    label: string;
  } | null;
  webSearchProviderRegistered: boolean;
} {
  const captured = createCapturedPluginRegistration();
  googlePlugin.register(captured.api);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  const webSearchProvider = captured.webSearchProviders[0] ?? null;
  return {
    provider,
    webSearchProviderRegistered: webSearchProvider !== null,
    webSearchProvider:
      webSearchProvider === null
        ? null
        : {
            id: webSearchProvider.id,
            envVars: webSearchProvider.envVars,
            label: webSearchProvider.label,
          },
  };
}

describe("google plugin", () => {
  it("registers both Gemini CLI auth and Gemini web search", () => {
    const result = registerGooglePlugin();

    expect(result.provider.id).toBe("google-gemini-cli");
    expect(result.webSearchProviderRegistered).toBe(true);
    expect(result.webSearchProvider).toMatchObject({
      id: "gemini",
      label: "Gemini (Google Search)",
      envVars: ["GEMINI_API_KEY"],
    });
  });

  it("owns gemini 3.1 forward-compat resolution", () => {
    const { provider } = registerGooglePlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gemini-3-pro-preview"
            ? {
                id,
                name: id,
                api: "google-gemini-cli",
                provider: "google-gemini-cli",
                baseUrl: "https://cloudcode-pa.googleapis.com",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              }
            : null,
      } as never,
    });

    expect(model).toMatchObject({
      id: "gemini-3.1-pro-preview",
      provider: "google-gemini-cli",
      reasoning: true,
    });
  });

  it("owns usage-token parsing", async () => {
    const { provider } = registerGooglePlugin();
    await expect(
      provider.resolveUsageAuth?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "google-gemini-cli",
        resolveApiKeyFromConfigAndStore: () => undefined,
        resolveOAuthToken: async () => ({
          token: '{"token":"google-oauth-token"}',
          accountId: "google-account",
        }),
      }),
    ).resolves.toEqual({
      token: "google-oauth-token",
      accountId: "google-account",
    });
  });

  it("owns usage snapshot fetching", async () => {
    const { provider } = registerGooglePlugin();
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")) {
        return makeResponse(200, {
          buckets: [
            { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.4 },
            { modelId: "gemini-3.1-flash-preview", remainingFraction: 0.8 },
          ],
        });
      }
      return makeResponse(404, "not found");
    });

    const snapshot = await provider.fetchUsageSnapshot?.({
      config: {} as never,
      env: {} as NodeJS.ProcessEnv,
      provider: "google-gemini-cli",
      token: "google-oauth-token",
      timeoutMs: 5_000,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot).toMatchObject({
      provider: "google-gemini-cli",
      displayName: "Gemini",
    });
    expect(snapshot?.windows[0]).toEqual({ label: "Pro", usedPercent: 60 });
    expect(snapshot?.windows[1]?.label).toBe("Flash");
    expect(snapshot?.windows[1]?.usedPercent).toBeCloseTo(20);
  });
});
