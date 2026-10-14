// Verifies GitHub Copilot profile token fallback and implicit provider planning.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import { resolveImplicitProviders } from "./models-config.providers.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

vi.mock("./model-auth-env.js", () => ({
  resolveEnvApiKey: () => null,
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => [],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

vi.mock("./models-config.providers.js", () => ({
  materializeConfiguredProviderCatalogModels: (providers: unknown) => providers,
  enforceSourceManagedProviderSecrets: ({ providers }: { providers: unknown }) => providers,
  normalizeProviderCatalogModelsForConfig: (providers: unknown) => providers,
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
  resolveImplicitProviders: vi.fn(),
}));

const resolveImplicitProvidersMock = vi.mocked(resolveImplicitProviders);

beforeEach(() => {
  resolveImplicitProvidersMock
    .mockReset()
    .mockImplementation(async ({ explicitProviders }) => explicitProviders ?? {});
});

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", () => {
    const auth = createProviderAuthResolver(
      {},
      {
        version: 1,
        profiles: {
          "github-copilot:alpha": {
            type: "token",
            provider: "github-copilot",
            token: "alpha-token",
          },
          "github-copilot:beta": {
            type: "token",
            provider: "github-copilot",
            token: "beta-token",
          },
        },
      },
    );

    expect(auth("github-copilot")).toEqual({
      apiKey: "alpha-token",
      discoveryApiKey: "alpha-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:alpha",
    });
  });

  it("keeps a non-empty existing models.json baseUrl when merge mode regenerates the provider", async () => {
    const kilocodeProvider = {
      baseUrl: "https://api.kilo.ai/api/gateway/v1",
      api: "openai-completions" as const,
      models: [],
    };
    const existing = {
      providers: { kilocode: { ...kilocodeProvider, baseUrl: "https://api.kilo.ai/api/gateway" } },
    };
    const plan = await planModelsJsonForTest({
      cfg: { models: { providers: { kilocode: kilocodeProvider } } },
      agentDir: "/tmp/openclaw-agent",
      env: {},
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
      existingParsed: existing,
    });

    expect(plan).toEqual({ action: "noop", pluginCatalogWrites: {} });
  });

  it("uses tokenRef env var when github-copilot profile omits plaintext token", () => {
    const auth = createProviderAuthResolver(
      {
        COPILOT_REF_TOKEN: "token-from-ref-env",
      },
      {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "COPILOT_REF_TOKEN" },
          },
        },
      },
    );

    expect(auth("github-copilot")).toEqual({
      apiKey: "COPILOT_REF_TOKEN",
      discoveryApiKey: "token-from-ref-env",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:default",
    });
  });
});
