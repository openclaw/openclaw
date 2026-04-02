import { describe, expect, it } from "vitest";
import { resolveProviderRequestConfig } from "./provider-request-config.js";

describe("provider request config", () => {
  it("merges discovered, provider, and model headers in precedence order", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      discoveredHeaders: {
        "X-Discovered": "1",
        "X-Shared": "discovered",
      },
      providerHeaders: {
        "X-Provider": "2",
        "X-Shared": "provider",
      },
      modelHeaders: {
        "X-Model": "3",
        "X-Shared": "model",
      },
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.headers).toEqual({
      "X-Discovered": "1",
      "X-Provider": "2",
      "X-Model": "3",
      "X-Shared": "model",
    });
  });

  it("surfaces authHeader intent without mutating headers yet", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      authHeader: true,
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.auth).toEqual({
      mode: "authorization-bearer",
      injectAuthorizationHeader: true,
    });
    expect(resolved.headers).toBeUndefined();
  });

  it("keeps future proxy and tls slots stable for current callers", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.proxy).toEqual({ configured: false });
    expect(resolved.tls).toEqual({ configured: false });
    expect(resolved.policy.endpointClass).toBe("openrouter");
    expect(resolved.policy.attributionProvider).toBe("openrouter");
  });
});
