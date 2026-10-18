import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCrmBaseUrl,
  resolveCrmApiKey,
  resolveCrmBaseUrl,
  resolveCrmConfig,
  resolveCrmTimeoutSeconds,
} from "./config.js";

function configWithCrm(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { crm: { config } } } } as OpenClawConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crm config", () => {
  it("normalizes the API base URL and rejects unsafe protocols", () => {
    expect(normalizeCrmBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
    expect(normalizeCrmBaseUrl(" https://crm.example.com/api/ ")).toBe(
      "https://crm.example.com/api",
    );
    expect(() => normalizeCrmBaseUrl("ftp://crm.example.com")).toThrow("http:// or https://");
    expect(() => normalizeCrmBaseUrl("https://user:pass@crm.example.com")).toThrow(
      "must not include credentials",
    );
  });

  it("prefers plugin config over environment fallbacks", () => {
    vi.stubEnv("CRM_BASE_URL", "http://env.example:3001");
    vi.stubEnv("CRM_API_KEY", "env-key");
    vi.stubEnv("CRM_TIMEOUT_SECONDS", "99");

    const cfg = configWithCrm({
      baseUrl: "https://crm.example.com",
      apiKey: "plugin-key",
      timeoutSeconds: 12,
    });

    expect(resolveCrmBaseUrl(cfg)).toBe("https://crm.example.com");
    expect(resolveCrmApiKey(cfg)).toBe("plugin-key");
    expect(resolveCrmTimeoutSeconds(cfg)).toBe(12);
  });

  it("falls back to environment values and defaults", () => {
    vi.stubEnv("CRM_BASE_URL", "http://env.example:3001");
    vi.stubEnv("CRM_API_KEY", "env-key");

    expect(resolveCrmBaseUrl()).toBe("http://env.example:3001");
    expect(resolveCrmApiKey()).toBe("env-key");
    expect(resolveCrmTimeoutSeconds()).toBe(30);
  });

  it("clamps the timeout to 1-300 seconds", () => {
    expect(resolveCrmTimeoutSeconds(configWithCrm({ timeoutSeconds: 0.4 }))).toBe(1);
    expect(resolveCrmTimeoutSeconds(configWithCrm({ timeoutSeconds: 500 }))).toBe(300);
    expect(resolveCrmTimeoutSeconds(configWithCrm({ timeoutSeconds: 0 }))).toBe(30);
  });

  it("resolves an environment SecretRef for the API key", () => {
    vi.stubEnv("CRM_API_KEY", "ref-key");
    const cfg = configWithCrm({
      apiKey: { source: "env", provider: "default", id: "CRM_API_KEY" },
    });

    expect(resolveCrmApiKey(cfg)).toBe("ref-key");
  });

  it("fails closed when the API key is missing", () => {
    expect(() => resolveCrmConfig()).toThrow("crm is not configured");
  });
});
