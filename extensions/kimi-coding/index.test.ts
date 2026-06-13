// Kimi Coding tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("kimi provider plugin", () => {
  it("normalizes legacy Kimi Code ids to the stable API model id", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        provider: "kimi",
        modelId: "kimi-code",
        model: {
          id: "kimi-code",
          name: "Kimi Code",
          provider: "kimi",
          api: "anthropic-messages",
        },
      } as never),
    ).toEqual({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      api: "anthropic-messages",
    });
  });

  it("uses binary thinking with thinking off by default", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "kimi-code",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("resolves Kimi Code usage auth from env and config sources", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.resolveUsageAuth?.({
        env: { KIMI_CODE_API_KEY: "env-kimi-code-key" },
        resolveApiKeyFromConfigAndStore: (options?: { envDirect?: Array<string | undefined> }) => {
          expect(options?.providerIds).toEqual(["kimi", "kimi-code", "kimi-coding"]);
          expect(options?.envDirect).toEqual(["env-kimi-code-key", undefined, undefined]);
          return "resolved-kimi-key";
        },
      } as never),
    ).resolves.toEqual({ token: "resolved-kimi-key" });
  });

  it("fetches Kimi Code usage windows through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const mockFetch = createProviderUsageFetch(async (url) => {
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      return makeResponse(200, {
        usage: { limit: 100, used: 12 },
        limits: [{ name: "5h", detail: { limit: 50, remaining: 45 } }],
      });
    });

    await expect(
      provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {},
        provider: "kimi",
        token: "kimi-key",
        timeoutMs: 5000,
        fetchFn: mockFetch,
      }),
    ).resolves.toEqual({
      provider: "kimi",
      displayName: "Kimi",
      windows: [
        { label: "5h", usedPercent: 10 },
        { label: "7d", usedPercent: 12 },
      ],
    });
  });

  it("uses configured Kimi provider baseUrl for usage endpoint", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const mockFetch = createProviderUsageFetch(async (url) => {
      expect(url).toBe("https://proxy.example/kimi/v1/usages");
      return makeResponse(200, {});
    });

    await provider.fetchUsageSnapshot?.({
      config: {
        models: {
          providers: {
            kimi: { baseUrl: "https://proxy.example/kimi/v1/" },
          },
        },
      } as never,
      env: {},
      provider: "kimi",
      token: "kimi-key",
      timeoutMs: 5000,
      fetchFn: mockFetch,
    });
  });
});
