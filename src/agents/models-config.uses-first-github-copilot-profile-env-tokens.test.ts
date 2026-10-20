import { beforeEach, expect, it, vi } from "vitest";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";
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

vi.mock("./models-config.providers.catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.catalog.js")>()),
  materializeConfiguredProviderCatalogModels: (providers: unknown) => providers,
  normalizeProviderCatalogModelsForConfig: (providers: unknown) => providers,
}));

vi.mock("./models-config.providers.source-managed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.source-managed.js")>()),
  enforceSourceManagedProviderSecrets: ({ providers }: { providers: unknown }) => providers,
}));

vi.mock("./models-config.providers.normalize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.normalize.js")>()),
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
}));

vi.mock("./models-config.providers.implicit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.implicit.js")>()),
  resolveImplicitProviders: vi.fn(),
}));

const resolveImplicitProvidersMock = vi.mocked(resolveImplicitProviders);
const tokenProfile = (token: string) => ({
  type: "token" as const,
  provider: "github-copilot",
  token,
});
const expectedAuth = (profile: string, apiKey: string, discoveryApiKey = apiKey) => ({
  apiKey,
  discoveryApiKey,
  mode: "token",
  source: "profile",
  profileId: `github-copilot:${profile}`,
});

beforeEach(() => {
  resolveImplicitProvidersMock
    .mockReset()
    .mockImplementation(async ({ explicitProviders }) => explicitProviders ?? {});
});

it.each([
  {
    name: "uses the first github-copilot profile when env tokens are missing",
    env: {},
    profiles: {
      "github-copilot:alpha": tokenProfile("alpha-token"),
      "github-copilot:beta": tokenProfile("beta-token"),
    },
    expected: expectedAuth("alpha", "alpha-token"),
  },
  {
    name: "uses tokenRef env var when github-copilot profile omits plaintext token",
    env: { COPILOT_REF_TOKEN: "token-from-ref-env" },
    profiles: {
      "github-copilot:default": {
        type: "token" as const,
        provider: "github-copilot",
        tokenRef: { source: "env" as const, provider: "default", id: "COPILOT_REF_TOKEN" },
      },
    },
    expected: expectedAuth("default", "COPILOT_REF_TOKEN", "token-from-ref-env"),
  },
] as const)("$name", ({ env, profiles, expected }) => {
  const auth = createProviderAuthResolver(env, { version: 1, profiles });
  expect(auth("github-copilot")).toEqual(expected);
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
