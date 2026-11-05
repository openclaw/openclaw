import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ loaded: false, run: vi.fn() }));
vi.mock("./provider-catalog.js", () => {
  runtime.loaded = true;
  return { buildDeepInfraApiKeyCatalog: runtime.run };
});

describe("DeepInfra provider discovery entry", () => {
  it("publishes static models before loading live catalog runtime", async () => {
    const { default: provider } = await import("./provider-discovery.js");
    expect(runtime.loaded).toBe(false);
    const ctx: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const catalog = await provider.staticCatalog?.run(ctx);
    expect(catalog).toMatchObject({
      provider: {
        baseUrl: "https://api.deepinfra.com/v1/openai",
        api: "openai-completions",
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "deepseek-ai/DeepSeek-V4-Flash",
            compat: expect.objectContaining({
              supportsUsageInStreaming: true,
              thinkingFormat: "deepseek",
            }),
          }),
        ]),
      },
    });
    expect(runtime.loaded).toBe(false);

    const result = { provider: { models: [] } };
    runtime.run.mockResolvedValue(result);
    expect(await provider.catalog?.run(ctx)).toBe(result);
    expect(runtime.loaded).toBe(true);
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
