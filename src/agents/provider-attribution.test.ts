import { describe, expect, it } from "vitest";
import {
  listProviderAttributionPolicies,
  resolveProviderAttributionHeaders,
  resolveProviderAttributionIdentity,
  resolveProviderAttributionPolicy,
  resolveProviderRequestAttributionHeaders,
  resolveProviderRequestPolicy,
} from "./provider-attribution.js";

describe("provider attribution", () => {
  it("resolves the canonical OpenClaw product and runtime version", () => {
    const identity = resolveProviderAttributionIdentity({
      OPENCLAW_VERSION: "2026.3.99",
    });

    expect(identity).toEqual({
      product: "OpenClaw",
      version: "2026.3.99",
    });
  });

  it("returns a documented OpenRouter attribution policy", () => {
    const policy = resolveProviderAttributionPolicy("openrouter", {
      OPENCLAW_VERSION: "2026.3.22",
    });

    expect(policy).toEqual({
      provider: "openrouter",
      enabledByDefault: true,
      verification: "vendor-documented",
      hook: "request-headers",
      docsUrl: "https://openrouter.ai/docs/app-attribution",
      reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
        "X-OpenRouter-Categories": "cli-agent",
      },
    });
  });

  it("normalizes aliases when resolving provider headers", () => {
    expect(
      resolveProviderAttributionHeaders("OpenRouter", {
        OPENCLAW_VERSION: "2026.3.22",
      }),
    ).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  it("returns a hidden-spec OpenAI attribution policy", () => {
    expect(resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      provider: "openai",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
    expect(resolveProviderAttributionHeaders("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("returns a hidden-spec OpenAI Codex attribution policy", () => {
    expect(
      resolveProviderAttributionPolicy("openai-codex", { OPENCLAW_VERSION: "2026.3.22" }),
    ).toEqual({
      provider: "openai-codex",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "OpenAI Codex ChatGPT-backed traffic supports the same hidden originator/User-Agent attribution contract.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
  });

  it("lists the current attribution support matrix", () => {
    expect(
      listProviderAttributionPolicies({ OPENCLAW_VERSION: "2026.3.22" }).map((policy) => [
        policy.provider,
        policy.enabledByDefault,
        policy.verification,
        policy.hook,
      ]),
    ).toEqual([
      ["openrouter", true, "vendor-documented", "request-headers"],
      ["openai", true, "vendor-hidden-api-spec", "request-headers"],
      ["openai-codex", true, "vendor-hidden-api-spec", "request-headers"],
      ["anthropic", false, "vendor-sdk-hook-only", "default-headers"],
      ["google", false, "vendor-sdk-hook-only", "user-agent-extra"],
      ["groq", false, "vendor-sdk-hook-only", "default-headers"],
      ["mistral", false, "vendor-sdk-hook-only", "custom-user-agent"],
      ["together", false, "vendor-sdk-hook-only", "default-headers"],
    ]);
  });

  it("authorizes hidden OpenAI attribution only on verified native hosts", () => {
    expect(
      resolveProviderRequestPolicy(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
    ).toMatchObject({
      endpointClass: "openai-public",
      attributionProvider: "openai",
      allowsHiddenAttribution: true,
      usesKnownNativeOpenAIEndpoint: true,
      usesVerifiedOpenAIAttributionHost: true,
      usesExplicitProxyLikeEndpoint: false,
    });

    expect(
      resolveProviderRequestPolicy(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
    ).toMatchObject({
      endpointClass: "custom",
      attributionProvider: undefined,
      allowsHiddenAttribution: false,
      usesKnownNativeOpenAIEndpoint: false,
      usesVerifiedOpenAIAttributionHost: false,
      usesExplicitProxyLikeEndpoint: true,
    });
  });

  it("classifies OpenAI-family default, codex, and Azure routes distinctly", () => {
    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-responses",
        transport: "stream",
        capability: "llm",
      }),
    ).toMatchObject({
      endpointClass: "default",
      attributionProvider: undefined,
      usesKnownNativeOpenAIRoute: true,
      usesExplicitProxyLikeEndpoint: false,
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "openai-codex",
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        transport: "stream",
        capability: "llm",
      }),
    ).toMatchObject({
      endpointClass: "openai-codex",
      attributionProvider: "openai-codex",
      allowsHiddenAttribution: true,
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "azure-openai",
        api: "azure-openai-responses",
        baseUrl: "https://tenant.openai.azure.com/openai/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toMatchObject({
      endpointClass: "azure-openai",
      attributionProvider: undefined,
      allowsHiddenAttribution: false,
      usesKnownNativeOpenAIEndpoint: true,
    });
  });

  it("treats OpenRouter-hosted Responses routes as explicit proxy-like endpoints", () => {
    expect(
      resolveProviderRequestPolicy({
        provider: "openrouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toMatchObject({
      endpointClass: "openrouter",
      usesExplicitProxyLikeEndpoint: true,
      attributionProvider: "openrouter",
    });
  });

  it("keeps documented OpenRouter attribution centralized while leaving host-gating deferred", () => {
    expect(
      resolveProviderRequestPolicy({
        provider: "openrouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toMatchObject({
      endpointClass: "openrouter",
      attributionProvider: "openrouter",
      allowsHiddenAttribution: false,
    });

    expect(
      resolveProviderRequestAttributionHeaders({
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  it("models other provider families without enabling hidden attribution", () => {
    expect(
      resolveProviderRequestPolicy({
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        transport: "http",
        capability: "image",
      }),
    ).toMatchObject({
      knownProviderFamily: "google",
      attributionProvider: undefined,
      allowsHiddenAttribution: false,
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "github-copilot",
        transport: "http",
        capability: "llm",
      }),
    ).toMatchObject({
      knownProviderFamily: "github-copilot",
      attributionProvider: undefined,
      allowsHiddenAttribution: false,
    });
  });

  it("requires the dedicated OpenAI audio transcription API for audio attribution", () => {
    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-audio-transcriptions",
        baseUrl: "https://api.openai.com/v1",
        transport: "media-understanding",
        capability: "audio",
      }),
    ).toMatchObject({
      attributionProvider: "openai",
      allowsHiddenAttribution: true,
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        transport: "media-understanding",
        capability: "audio",
      }),
    ).toMatchObject({
      attributionProvider: "openai",
      allowsHiddenAttribution: true,
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "not-openai-audio",
        baseUrl: "https://api.openai.com/v1",
        transport: "media-understanding",
        capability: "audio",
      }),
    ).toMatchObject({
      attributionProvider: undefined,
      allowsHiddenAttribution: false,
    });
  });
});
