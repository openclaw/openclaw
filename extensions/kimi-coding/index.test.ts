import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("kimi provider plugin", () => {
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

  it("allows user to override api field from provider config", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            kimi: {
              baseUrl: "https://api.kimi.com/coding/v1",
              api: "openai-completions",
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as unknown as ProviderCatalogContext);

    expect(result).toBeTruthy();
    const catalogProvider = (result as { provider: Record<string, unknown> }).provider;
    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.kimi.com/coding/v1");
  });

  it("allows user to override api field without overriding baseUrl", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            kimi: {
              api: "openai-completions",
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as unknown as ProviderCatalogContext);

    expect(result).toBeTruthy();
    const catalogProvider = (result as { provider: Record<string, unknown> }).provider;
    expect(catalogProvider.api).toBe("openai-completions");
    // baseUrl should remain the built-in default
    expect(catalogProvider.baseUrl).toBe("https://api.kimi.com/coding/");
  });

  it("uses built-in api when user does not override", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            kimi: {
              baseUrl: "https://api.kimi.com/coding/",
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as unknown as ProviderCatalogContext);

    expect(result).toBeTruthy();
    const catalogProvider = (result as { provider: Record<string, unknown> }).provider;
    expect(catalogProvider.api).toBe("anthropic-messages");
  });
});
