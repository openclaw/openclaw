import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    plugins: [
      {
        id: "fixture-provider",
        providerAuthEnvVars: {
          "fixture-provider": ["FIXTURE_PROVIDER_API_KEY"],
        },
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
      },
    ],
    diagnostics: [],
  })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("provider auth aliases", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockClear();
  });

  it("shares manifest env vars across aliased providers", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        FIXTURE_PROVIDER_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for aliased providers", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "fixture-provider:default": {
          type: "api_key",
          provider: "fixture-provider",
          keyRef: { source: "env", provider: "default", id: "FIXTURE_PROVIDER_API_KEY" },
        },
      },
    });

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "fixture-provider:default",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "fixture-provider:default",
    });
  });
});
