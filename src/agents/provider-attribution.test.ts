import { describe, expect, it } from "vitest";
import {
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
      docsUrl: "https://openrouter.ai/docs/app-attribution",
      product: "OpenClaw",
      version: "2026.3.14",
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw",
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
      "X-Title": "OpenClaw",
    });
  });

  it("does not resolve attribution for unsupported providers", () => {
    expect(resolveProviderAttributionPolicy("openai")).toBeUndefined();
    expect(resolveProviderAttributionHeaders("openai")).toBeUndefined();
  });
});
