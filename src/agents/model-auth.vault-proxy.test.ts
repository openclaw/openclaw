import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

describe("resolveVaultProxyUrl", () => {
  it("returns undefined when vault is not configured", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    expect(resolveVaultProxyUrl(undefined, "openai")).toBeUndefined();
    expect(resolveVaultProxyUrl({}, "openai")).toBeUndefined();
  });

  it("returns undefined when vault.enabled is false", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: false,
        proxies: { openai: "http://vault:8081" },
      },
    };

    expect(resolveVaultProxyUrl(cfg, "openai")).toBeUndefined();
  });

  it("returns proxy URL for matching provider", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: {
          openai: "http://vault:8081",
          anthropic: "http://vault:8082",
          deepgram: "http://vault:8083",
        },
      },
    };

    expect(resolveVaultProxyUrl(cfg, "openai")).toBe("http://vault:8081");
    expect(resolveVaultProxyUrl(cfg, "anthropic")).toBe("http://vault:8082");
    expect(resolveVaultProxyUrl(cfg, "deepgram")).toBe("http://vault:8083");
  });

  it("returns undefined for provider without proxy mapping", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };

    expect(resolveVaultProxyUrl(cfg, "ollama")).toBeUndefined();
  });

  it("returns undefined when proxies is empty", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: {},
      },
    };

    expect(resolveVaultProxyUrl(cfg, "openai")).toBeUndefined();
  });

  it("resolves proxy URL for non-normalized provider ID", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };

    // "OpenAI" normalizes to "openai" via normalizeProviderId
    expect(resolveVaultProxyUrl(cfg, "OpenAI")).toBe("http://vault:8081");
  });

  it("returns undefined when proxies is not set", async () => {
    vi.resetModules();
    const { resolveVaultProxyUrl } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
      },
    };

    expect(resolveVaultProxyUrl(cfg, "openai")).toBeUndefined();
  });
});

describe("resolveApiKeyForProvider vault proxy mode", () => {
  it("returns placeholder key when vault proxy is configured", async () => {
    vi.resetModules();
    const { resolveApiKeyForProvider } = await import("./model-auth.js");

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };

    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      cfg,
      store: { version: 1, profiles: {} },
    });

    expect(resolved.apiKey).toBe("vault-proxy-managed");
    expect(resolved.source).toBe("vault-proxy");
    expect(resolved.mode).toBe("api-key");
  });

  it("falls through to normal resolution when vault proxy is not configured for provider", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-real-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const cfg: OpenClawConfig = {
        vault: {
          enabled: true,
          proxies: { anthropic: "http://vault:8082" },
        },
      };

      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        cfg,
        store: { version: 1, profiles: {} },
      });

      expect(resolved.apiKey).toBe("sk-real-key");
      expect(resolved.source).toContain("OPENAI_API_KEY");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("vault proxy takes precedence over env var API key", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-real-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const cfg: OpenClawConfig = {
        vault: {
          enabled: true,
          proxies: { openai: "http://vault:8081" },
        },
      };

      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        cfg,
        store: { version: 1, profiles: {} },
      });

      // Vault proxy must win over env var
      expect(resolved.apiKey).toBe("vault-proxy-managed");
      expect(resolved.source).toBe("vault-proxy");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });
});
