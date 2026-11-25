import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it } from "vitest";

describe("Groq provider discovery entry", () => {
  it("publishes manifest models through the static catalog", async () => {
    const { default: provider } = await import("./provider-discovery.js");
    const ctx: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };

    await expect(provider.staticCatalog?.run(ctx)).resolves.toMatchObject({
      provider: {
        baseUrl: "https://api.groq.com/openai/v1",
        api: "openai-completions",
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "openai/gpt-oss-120b",
            name: "GPT OSS 120B",
            reasoning: true,
            contextWindow: 131_072,
            maxTokens: 65_536,
          }),
        ]),
      },
    });
  });
});
