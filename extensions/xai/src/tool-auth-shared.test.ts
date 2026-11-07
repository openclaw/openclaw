import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNonEnvSecretRefApiKeyMarker } from "openclaw/plugin-sdk/secret-input";
import { afterEach, expect, it, vi } from "vitest";
import {
  isXaiToolEnabled,
  resolveFallbackXaiAuth,
  resolveXaiToolAuth,
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

function profileAuth() {
  return {
    hasAuthForProvider: vi.fn((providerId: string) => providerId === "xai"),
    resolveAuthForProvider: vi.fn(async (providerId: string) =>
      providerId === "xai"
        ? { apiKey: "profile-key", mode: "oauth" as const, profileId: "xai:test" }
        : undefined,
    ),
  };
}

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
  const runtimeConfig = config("runtime-key");
  const sourceConfig = config("source-key");
  await expect(resolveXaiToolAuth({ runtimeConfig, sourceConfig })).resolves.toEqual({
    apiKey: "runtime-key",
    mode: "api-key",
  });
  await expect(resolveXaiToolAuth({ sourceConfig })).resolves.toEqual({
    apiKey: "source-key",
    mode: "api-key",
  });
  await expect(resolveXaiToolAuth({})).resolves.toEqual({ apiKey: "env-key", mode: "api-key" });
});

it("honors explicit disabled flags before auth fallback", () => {
  vi.stubEnv("XAI_API_KEY", "env-key");
  expect(isXaiToolEnabled({ enabled: false })).toBe(false);
  expect(isXaiToolEnabled({ enabled: true })).toBe(true);
});

it("uses xAI auth profiles when tool config and env are absent", async () => {
  const auth = profileAuth();

  expect(isXaiToolEnabled({ auth })).toBe(true);
  await expect(resolveXaiToolAuth({ auth })).resolves.toEqual({
    apiKey: "profile-key",
    mode: "oauth",
    profileId: "xai:test",
  });
});

it.each([
  [
    "missing configured env ref",
    undefined,
    secretRefConfig("env", "selected", "XAI_API_KEY", {
      defaults: { env: "selected" },
      providers: { selected: { source: "env" } },
    }),
  ],
  ["blocked explicit tool config", "env-key", secretRefConfig("file", "vault", "/xai/tool-key")],
] as const)("does not borrow profile auth for %s", async (_kind, env, sourceConfig) => {
  vi.stubEnv("XAI_API_KEY", env);
  const auth = profileAuth();
  expect(isXaiToolEnabled({ sourceConfig, auth })).toBe(false);
  await expect(resolveXaiToolAuth({ sourceConfig, auth })).resolves.toBeUndefined();
  expect(auth.hasAuthForProvider).not.toHaveBeenCalled();
  expect(auth.resolveAuthForProvider).not.toHaveBeenCalled();
});

it.each([
  ["arbitrary env id", secretRefConfig("env", "default", "UNRELATED_SECRET")],
  [
    "provider allowlist exclusion",
    secretRefConfig("env", "xai-env", "XAI_API_KEY", {
      providers: { "xai-env": { source: "env", allowlist: ["OTHER_XAI_API_KEY"] } },
    }),
  ],
  [
    "non-env provider",
    secretRefConfig("env", "xai-env", "XAI_API_KEY", {
      providers: { "xai-env": { source: "file", path: "/tmp/secrets.json" } },
    }),
  ],
] as const)("rejects env SecretRefs with %s", async (_kind, sourceConfig) => {
  vi.stubEnv("UNRELATED_SECRET", "should-not-be-read");
  vi.stubEnv("XAI_API_KEY", "xai-secretref-key");
  await expect(resolveXaiToolAuth({ sourceConfig })).resolves.toBeUndefined();
});
