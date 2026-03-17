import { describe, expect, it } from "vitest";
import {
  listProviderAttributionPolicies,
  resolveProviderAttributionHeaders,
  resolveProviderAttributionIdentity,
  resolveProviderAttributionPolicy,
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
      OPENCLAW_VERSION: "2026.3.14",
    });

    expect(policy).toEqual({
      provider: "openrouter",
      enabledByDefault: true,
      verification: "vendor-documented",
      hook: "request-headers",
      docsUrl: "https://openrouter.ai/docs/app-attribution",
      reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
      product: "OpenClaw",
      version: "2026.3.14",
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
        OPENCLAW_VERSION: "2026.3.14",
      }),
    ).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  it("tracks SDK-hook-only providers without enabling them", () => {
    expect(resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.14" })).toEqual({
      provider: "openai",
      enabledByDefault: false,
      verification: "vendor-sdk-hook-only",
      hook: "default-headers",
      reviewNote:
        "OpenAI JS SDK exposes defaultHeaders, but public app attribution support is not yet verified.",
      product: "OpenClaw",
      version: "2026.3.14",
    });
    expect(resolveProviderAttributionHeaders("openai")).toBeUndefined();
  });

  it("lists the current attribution support matrix", () => {
    expect(
      listProviderAttributionPolicies({ OPENCLAW_VERSION: "2026.3.14" }).map((policy) => [
        policy.provider,
        policy.enabledByDefault,
        policy.verification,
        policy.hook,
      ]),
    ).toEqual([
      ["openrouter", true, "vendor-documented", "request-headers"],
      ["anthropic", false, "vendor-sdk-hook-only", "default-headers"],
      ["google", false, "vendor-sdk-hook-only", "user-agent-extra"],
      ["groq", false, "vendor-sdk-hook-only", "default-headers"],
      ["mistral", false, "vendor-sdk-hook-only", "custom-user-agent"],
      ["openai", false, "vendor-sdk-hook-only", "default-headers"],
      ["together", false, "vendor-sdk-hook-only", "default-headers"],
    ]);
  });
});
