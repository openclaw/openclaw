import { expect, it, vi } from "vitest";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import type { resolveImplicitProviders } from "./models-config.providers.implicit.js";
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

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-runtime.js")>()),
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

vi.mock("./models-config.providers.implicit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.implicit.js")>()),
  resolveImplicitProviders: async ({
    explicitProviders,
  }: Parameters<typeof resolveImplicitProviders>[0]) => explicitProviders ?? {},
}));

const tokenCredential = { type: "token" as const, provider: "github-copilot" };
const expectedAuth = (profile: string, apiKey: string, discoveryApiKey = apiKey) => ({
  apiKey,
  discoveryApiKey,
  mode: "token",
  source: "profile",
  profileId: `github-copilot:${profile}`,
});

it.each([
  [
    "uses the first github-copilot profile when env tokens are missing",
    {},
    {
      "github-copilot:alpha": { ...tokenCredential, token: "alpha-token" },
      "github-copilot:beta": { ...tokenCredential, token: "beta-token" },
    },
    expectedAuth("alpha", "alpha-token"),
  ],
  [
    "uses tokenRef env var when github-copilot profile omits plaintext token",
    { COPILOT_REF_TOKEN: "token-from-ref-env" },
    {
      "github-copilot:default": {
        ...tokenCredential,
        tokenRef: { source: "env" as const, provider: "default", id: "COPILOT_REF_TOKEN" },
      },
    },
    expectedAuth("default", "COPILOT_REF_TOKEN", "token-from-ref-env"),
  ],
] as const)("%s", (_name, env, profiles, expected) => {
  const auth = createProviderAuthResolver(env, { version: 1, profiles });
  expect(auth("github-copilot")).toEqual(expected);
});

it("keeps a non-empty existing models.json baseUrl when merge mode regenerates the provider", async () => {
  const baseUrl = "https://api.kilo.ai/api/gateway";
  const provider = { baseUrl: `${baseUrl}/v1`, api: "openai-completions" as const, models: [] };
  const existing = { providers: { kilocode: { ...provider, baseUrl } } };
  const plan = await planModelsJsonForTest({
    cfg: { models: { providers: { kilocode: provider } } },
    agentDir: "/tmp/openclaw-agent",
    env: {},
    existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
    existingParsed: existing,
  });

  expect(plan).toEqual({ action: "noop", pluginCatalogWrites: {} });
});
