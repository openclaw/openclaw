import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

describe("requireApiKey", () => {
  it("returns trimmed key on success", async () => {
    vi.resetModules();
    const { requireApiKey } = await import("./model-auth.js");

    const result = requireApiKey(
      { apiKey: "  sk-test-key  ", source: "env: OPENAI_API_KEY", mode: "api-key" },
      "openai",
    );

    expect(result).toBe("sk-test-key");
  });

  it("throws with provider name when key is undefined", async () => {
    vi.resetModules();
    const { requireApiKey } = await import("./model-auth.js");

    expect(() =>
      requireApiKey({ apiKey: undefined, source: "vault-proxy", mode: "api-key" }, "anthropic"),
    ).toThrow(/No API key resolved for provider "anthropic"/);
  });

  it("throws with auth mode in error message", async () => {
    vi.resetModules();
    const { requireApiKey } = await import("./model-auth.js");

    expect(() =>
      requireApiKey({ apiKey: undefined, source: "vault-proxy", mode: "oauth" }, "openai"),
    ).toThrow(/auth mode: oauth/);
  });

  it("throws when key is whitespace-only", async () => {
    vi.resetModules();
    const { requireApiKey } = await import("./model-auth.js");

    expect(() =>
      requireApiKey({ apiKey: "   ", source: "models.json", mode: "api-key" }, "groq"),
    ).toThrow(/No API key resolved for provider "groq"/);
  });
});

describe("resolveModelAuthMode vault proxy", () => {
  it("returns api-key when vault proxy is configured for provider", async () => {
    vi.resetModules();
    const { resolveModelAuthMode } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };

    const mode = resolveModelAuthMode("openai", cfg, { version: 1, profiles: {} });
    expect(mode).toBe("api-key");
  });

  it("returns unknown when vault proxy is not configured for provider", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;

      vi.resetModules();
      const { resolveModelAuthMode } = await import("./model-auth.js");

      const cfg: OpenClawConfig = {
        vault: {
          enabled: true,
          proxies: { anthropic: "http://vault:8082" },
        },
      };

      const mode = resolveModelAuthMode("openai", cfg, { version: 1, profiles: {} });
      expect(mode).toBe("unknown");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("returns undefined for empty provider string", async () => {
    vi.resetModules();
    const { resolveModelAuthMode } = await import("./model-auth.js");

    expect(resolveModelAuthMode("", undefined)).toBeUndefined();
    expect(resolveModelAuthMode(undefined, undefined)).toBeUndefined();
  });
});
