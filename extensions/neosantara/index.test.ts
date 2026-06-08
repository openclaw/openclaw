import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("neosantara provider registration", () => {
  it("registers Neosantara provider", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Neosantara provider");
    }
    expect(provider.id).toBe("neosantara");
    expect(provider.label).toBe("Neosantara");
    expect(provider.docsPath).toBe("/providers/neosantara");
    expect(provider.envVars).toEqual(["NEOSANTARA_API_KEY"]);
    expect(provider.aliases).toEqual(["neosantara-responses"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0].id).toBe("api-key");
    expect(provider.auth[0].kind).toBe("api_key");
  });

  it("returns explicit provider configs for both neosantara and neosantara-responses in catalog", async () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Neosantara provider");
    }

    const mockCtx = {
      config: {},
      env: {},
      resolveProviderApiKey: (providerId: string) => {
        if (providerId === "neosantara") {
          return { apiKey: "test-key" };
        }
        return { apiKey: undefined };
      },
      resolveProviderAuth: (providerId: string) => {
        if (providerId === "neosantara") {
          return { apiKey: "test-key", mode: "api_key", source: "env" };
        }
        return { apiKey: undefined, mode: "none", source: "none" };
      },
    };

    const result = await provider.catalog?.run(mockCtx as any);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("providers");

    const providers = (result as any).providers;
    expect(providers).toHaveProperty("neosantara");
    expect(providers).toHaveProperty("neosantara-responses");

    // Check neosantara config
    expect(providers.neosantara.apiKey).toBe("test-key");
    expect(providers.neosantara.api).toBe("openai-completions");

    // Check neosantara-responses config
    expect(providers["neosantara-responses"].apiKey).toBe("test-key");
    expect(providers["neosantara-responses"].api).toBe("openai-responses");
    expect(providers["neosantara-responses"].models[0].api).toBe("openai-responses");
  });

  it("normalizes transport for neosantara", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Neosantara provider");
    }
    expect(
      provider.normalizeTransport?.({
        provider: "neosantara",
        api: "openai-completions",
        baseUrl: "https://api.neosantara.xyz/v1",
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.neosantara.xyz/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "neosantara-responses",
        api: "openai-responses",
        baseUrl: "https://api.neosantara.xyz/v1",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.neosantara.xyz/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "neosantara",
        api: "openai-responses",
        baseUrl: "https://api.neosantara.xyz/v1",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.neosantara.xyz/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "other-provider",
        api: "openai-completions",
        baseUrl: "https://other.com/v1",
      }),
    ).toBeUndefined();
  });
});
