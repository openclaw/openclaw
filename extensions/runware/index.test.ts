import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
// Runware tests cover index plugin behavior.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.unstubAllGlobals();
});

describe("runware provider plugin", () => {
  it("registers with the expected id, env var, and auth method", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.id).toBe("runware");
    expect(provider.envVars).toEqual(["RUNWARE_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]?.id).toBe("api-key");
  });

  it("returns null from catalog.run without a configured API key", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    } as never);
    expect(result).toBeNull();
  });

  it("builds a live-discovered provider once an API key is resolved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "deepseek-v4-flash",
                  context_length: 128000,
                  max_output_tokens: 65536,
                  pricing: { prompt: "0.000001", completion: "0.000002" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as unknown as typeof fetch,
    );

    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {},
      resolveProviderApiKey: () => ({ apiKey: "rw_test_key" }),
    } as never);

    expect(result).toMatchObject({
      provider: {
        baseUrl: "https://api.runware.ai/v1",
        api: "openai-completions",
        apiKey: "rw_test_key",
        models: [
          {
            id: "deepseek-v4-flash",
            contextWindow: 128000,
            maxTokens: 65536,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
  });

  it("serves an offline placeholder from staticCatalog.run without network access", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.staticCatalog?.run({} as never);
    expect(result).toMatchObject({
      provider: { baseUrl: "https://api.runware.ai/v1", api: "openai-completions" },
    });
    expect((result as { provider: { models: unknown[] } }).provider.models.length).toBeGreaterThan(
      0,
    );
  });

  it("only wraps the stream for the runware provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(
      provider.wrapStreamFn?.({
        provider: "openai",
        modelId: "gpt-5",
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
    expect(
      provider.wrapStreamFn?.({
        provider: "runware",
        modelId: "deepseek-v4-flash",
        streamFn: undefined,
      } as never),
    ).toBeDefined();
  });
});
