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
    expect(provider.hookAliases).toEqual(["neosantara-responses"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0].id).toBe("api-key");
    expect(provider.auth[0].kind).toBe("api_key");
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
