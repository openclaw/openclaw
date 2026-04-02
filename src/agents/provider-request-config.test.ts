import { describe, expect, it } from "vitest";
import {
  resolveProviderRequestConfig,
  resolveProviderRequestHeaders,
} from "./provider-request-config.js";

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

  it("lets defaults override caller headers when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      capability: "llm",
      transport: "stream",
      callerHeaders: {
        originator: "spoofed",
        "User-Agent": "spoofed/0.0.0",
        "X-Custom": "1",
      },
      precedence: "defaults-win",
    });

    expect(resolved).toMatchObject({
      originator: "openclaw",
      version: expect.any(String),
      "User-Agent": expect.stringMatching(/^openclaw\//),
      "X-Custom": "1",
    });
  });

  it("lets caller headers override defaults when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openrouter",
      api: "openai-completions",
      capability: "llm",
      transport: "stream",
      callerHeaders: {
        "HTTP-Referer": "https://example.com",
        "X-Custom": "1",
      },
      precedence: "caller-wins",
    });

    expect(resolved).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
      "X-Custom": "1",
    });
  });
});
