import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNonEnvSecretRefApiKeyMarker } from "openclaw/plugin-sdk/secret-input";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isXaiToolEnabled,
  resolveFallbackXaiAuth,
  resolveXaiToolApiKeyWithAuth,
} from "./tool-auth-shared.js";

function config(apiKey: unknown, secrets?: OpenClawConfig["secrets"]): OpenClawConfig {
  return {
    plugins: { entries: { xai: { config: { webSearch: { apiKey } } } } },
    ...(secrets && { secrets }),
  };
}

function secretRefConfig(
  source: "env" | "file",
  provider: string,
  id: string,
  secrets?: OpenClawConfig["secrets"],
) {
  return config({ source, provider, id }, secrets);
}

describe("xai tool auth helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses plugin web search keys", () => {
    expect(resolveFallbackXaiAuth(config("plugin-key"))).toEqual({
      apiKey: "plugin-key",
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("returns source metadata and managed markers for fallback auth", () => {
    expect(resolveFallbackXaiAuth(secretRefConfig("file", "vault", "/xai/tool-key"))).toEqual({
      apiKey: resolveNonEnvSecretRefApiKeyMarker("file"),
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("falls back to runtime, then source config, then env for tool auth", async () => {
    vi.stubEnv("XAI_API_KEY", "env-key");

    await expect(
      resolveXaiToolApiKeyWithAuth({
        runtimeConfig: config("runtime-key"),
        sourceConfig: config("source-key"),
      }),
    ).resolves.toBe("runtime-key");

    await expect(
      resolveXaiToolApiKeyWithAuth({ sourceConfig: config("source-key") }),
    ).resolves.toBe("source-key");

    await expect(resolveXaiToolApiKeyWithAuth({})).resolves.toBe("env-key");
  });

  it("honors explicit disabled flags before auth fallback", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");
    expect(isXaiToolEnabled({ enabled: false })).toBe(false);
    expect(isXaiToolEnabled({ enabled: true })).toBe(true);
  });

  it("uses xAI auth profiles when tool config and env are absent", async () => {
    const auth = {
      hasAuthForProvider: (providerId: string) => providerId === "xai",
      resolveApiKeyForProvider: async (providerId: string) =>
        providerId === "xai" ? "profile-key" : undefined, // pragma: allowlist secret
    };

    expect(isXaiToolEnabled({ auth })).toBe(true);
    await expect(resolveXaiToolApiKeyWithAuth({ auth })).resolves.toBe("profile-key");
  });

  it("does not borrow profile auth for a missing configured env ref", async () => {
    vi.stubEnv("XAI_API_KEY", undefined);
    const auth = {
      hasAuthForProvider: vi.fn(() => true),
      resolveApiKeyForProvider: vi.fn(async () => "profile-key"),
    };
    const sourceConfig = secretRefConfig("env", "selected", "XAI_API_KEY", {
      defaults: { env: "selected" },
      providers: { selected: { source: "env" } },
    });

    expect(isXaiToolEnabled({ sourceConfig, auth })).toBe(false);
    await expect(resolveXaiToolApiKeyWithAuth({ sourceConfig, auth })).resolves.toBeUndefined();
    expect(auth.hasAuthForProvider).not.toHaveBeenCalled();
    expect(auth.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not bypass blocked explicit tool config with auth profiles", async () => {
    vi.stubEnv("XAI_API_KEY", "env-key");
    const auth = {
      hasAuthForProvider: (providerId: string) => providerId === "xai",
      resolveApiKeyForProvider: async () => "profile-key", // pragma: allowlist secret
    };

    const sourceConfig = secretRefConfig("file", "vault", "/xai/tool-key");

    expect(isXaiToolEnabled({ sourceConfig, auth })).toBe(false);
    await expect(resolveXaiToolApiKeyWithAuth({ sourceConfig, auth })).resolves.toBeUndefined();
  });

  it("does not read arbitrary env SecretRef ids for xAI tool auth", async () => {
    vi.stubEnv("UNRELATED_SECRET", "should-not-be-read");

    await expect(
      resolveXaiToolApiKeyWithAuth({
        sourceConfig: secretRefConfig("env", "default", "UNRELATED_SECRET"),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not resolve env SecretRefs when provider allowlist excludes XAI_API_KEY", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-secretref-key");

    await expect(
      resolveXaiToolApiKeyWithAuth({
        sourceConfig: secretRefConfig("env", "xai-env", "XAI_API_KEY", {
          providers: { "xai-env": { source: "env", allowlist: ["OTHER_XAI_API_KEY"] } },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not resolve env SecretRefs when provider source is not env", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-secretref-key");

    await expect(
      resolveXaiToolApiKeyWithAuth({
        sourceConfig: secretRefConfig("env", "xai-env", "XAI_API_KEY", {
          providers: { "xai-env": { source: "file", path: "/tmp/secrets.json" } },
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
