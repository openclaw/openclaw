import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as authProfileStoreRuntime from "./auth-profiles/store-runtime.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import * as modelsConfigProviders from "./models-config.providers.implicit.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  normalizeProviderConfigWithPlugin: vi.fn<
    typeof import("../plugins/provider-runtime.js").normalizeProviderConfigWithPlugin
  >(() => undefined),
  resolveProviderConfigApiKeyWithPlugin: vi.fn<
    typeof import("../plugins/provider-runtime.js").resolveProviderConfigApiKeyWithPlugin
  >(() => undefined),
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => Object.create(null) as Record<string, string>,
  resolveProviderIdForAuth: (providerId: string) => providerId.trim().toLowerCase(),
}));
// mock-isolation: Model-config planning uses supplied catalog and environment policies without external credential discovery.
vi.mock("../plugins/provider-external-auth-core.js", async () =>
  (await import("../plugins/provider-external-auth.test-support.js")).createExternalAuthMock(),
);
vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: providerRuntimeMocks.normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin: providerRuntimeMocks.resolveProviderConfigApiKeyWithPlugin,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));
vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => [
    "GOOGLE_CLOUD_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {
      "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
    },
    authEvidenceMap: {},
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(providerRuntimeMocks)) {
    mock.mockReset();
    mock.mockReturnValue(undefined);
  }
});

const discover = (providers: Record<string, ProviderConfig>) =>
  vi.spyOn(modelsConfigProviders, "resolveImplicitProviders").mockResolvedValue(providers);

const defaultModel = modelDefinition("gpt-5.5", {
  name: "GPT-5.5",
  contextWindow: 400000,
  maxTokens: 128000,
});
const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseUrl: "https://api.openai.com/v1",
  api: "openai-responses",
  models: [structuredClone(defaultModel)],
  ...overrides,
});
async function generate(params: Partial<Parameters<typeof planModelsJsonForTest>[0]> = {}) {
  const authStore = params.authStore ?? { version: 1, profiles: {} };
  vi.spyOn(authProfileStoreRuntime, "ensureAuthProfileStoreAsync").mockResolvedValue(authStore);
  const plan = await planModelsJsonForTest({
    cfg: { models: { providers: {} } },
    agentDir: "/tmp/openclaw-models-config-env-vars-test",
    env: {},
    authStore,
    ...params,
  });
  if (plan.action !== "write") {
    throw new Error("Expected models.json write plan");
  }
  const parsed: { providers: Record<string, ProviderConfig> } = JSON.parse(plan.contents);
  return { ...plan, providers: parsed.providers };
}

describe("models-config planning", () => {
  it("does not expose the full registry to provider policy hooks for a scoped snapshot", async () => {
    providerRuntimeMocks.resolveProviderConfigApiKeyWithPlugin.mockReturnValue(
      "POLICY_ALIAS_API_KEY",
    );
    discover({
      "policy-alias": provider({ baseUrl: "https://policy.example/v1" }),
    });
    await generate({
      pluginMetadataSnapshot: {
        ...createPluginMetadataSnapshotFixture(),
        pluginIds: ["owner"],
      },
    });

    for (const mock of Object.values(providerRuntimeMocks)) {
      const params = mock.mock.calls.find(([call]) => call.provider === "policy-alias")?.[0];
      expect(params).toBeDefined();
      expect(params?.manifestRegistry).toBeUndefined();
    }
  });

  it("keeps the implicit catalog when the explicit baseUrl is blank", async () => {
    discover({ openai: provider() });
    const plan = await generate({
      cfg: providerConfig("openai", { baseUrl: "   ", apiKey: "OPENAI_API_KEY", models: [] }),
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    expect(plan.providers.openai).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "OPENAI_API_KEY",
      models: [{ id: "gpt-5.5" }],
    });
  });

  it("publishes keyless catalogs and leaves authentication to the registry", async () => {
    discover({
      openai: provider(),
      oauth: provider({ auth: "oauth" }),
      role: provider({ auth: "aws-sdk" }),
      empty: provider({ apiKey: "" }),
      "auth-only": provider({ models: [] }),
    });
    await withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
      const plan = await generate({
        existingParsed: {
          providers: {
            retained: provider({ auth: "oauth" }),
            "empty-existing": provider({ apiKey: "" }),
          },
        },
      });
      expect(Object.keys(plan.providers).toSorted()).toEqual([
        "auth-only",
        "oauth",
        "openai",
        "retained",
        "role",
      ]);
      for (const id of ["openai", "oauth", "role", "retained"]) {
        expect(plan.providers[id]).toMatchObject({ models: [{ id: "gpt-5.5" }] });
        expect(plan.providers[id]).not.toHaveProperty("apiKey");
      }
      const auth = AuthStorage.inMemory();
      const registry = ModelRegistry.create(auth, "/tmp/openclaw-keyless-catalog/models.json", {
        includePluginCatalogs: false,
        modelsJsonContents: plan.contents,
      });
      const model = registry.find("openai", "gpt-5.5");
      expect(registry.getError()).toBeUndefined();
      expect(registry.getAvailable()).not.toContain(model);
      auth.setRuntimeApiKey("openai", "synthetic-runtime-key");
      expect(registry.getAvailable()).toContain(model);
    });
  });

  it("treats empty replace-mode provider sets as authoritative", async () => {
    const discovery = discover({});
    const existingParsed = { providers: { stale: {} } };
    const plan = await generate({
      cfg: { models: { mode: "replace", providers: {} } },
      existingRaw: JSON.stringify(existingParsed),
      existingParsed,
    });
    expect(discovery).not.toHaveBeenCalled();
    expect(plan.providers).toEqual({});
    expect(plan.pluginCatalogWrites).toEqual({});
  });

  it("writes canonical env markers for discovered providers", async () => {
    discover({ openai: provider() });
    const plan = await generate({ env: { OPENAI_API_KEY: "sk-test" } });
    expect(plan.providers.openai?.apiKey).toBe("OPENAI_API_KEY");
  });

  it("keeps static catalog rows when an auth profile supplies the key", async () => {
    const agentDir = "/tmp/openclaw-google-vertex-models-profile";
    const vertex = provider({
      baseUrl: "https://{location}-aiplatform.googleapis.com",
      api: "google-vertex",
      models: [modelDefinition("gemini-2.5-pro")],
    });
    discover({ "google-vertex": vertex });
    const plan = await generate({
      agentDir,
      authStore: {
        version: 1,
        profiles: {
          "google-vertex:default": {
            type: "api_key",
            provider: "google-vertex",
            keyRef: { source: "env", provider: "default", id: "GOOGLE_CLOUD_API_KEY" },
          },
        },
      },
    });
    expect(plan.providers["google-vertex"]).toMatchObject({
      api: "google-vertex",
      apiKey: "GOOGLE_CLOUD_API_KEY",
      models: [{ id: "gemini-2.5-pro" }],
    });
  });

  it.each([undefined, "from-host"])(
    "uses config env vars without replacing host value %s",
    async (hostValue) => {
      const discovery = discover({
        openrouter: provider({
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          apiKey: "OPENROUTER_API_KEY",
        }),
      });
      await withEnvAsync({ OPENROUTER_API_KEY: hostValue }, async () => {
        const cfg: OpenClawConfig = {
          models: { providers: {} },
          env: { vars: { OPENROUTER_API_KEY: "from-config" } },
        };
        const plan = await generate({
          cfg,
          env: createConfigRuntimeEnv(cfg),
          pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
        });
        const discoveryEnv = discovery.mock.calls[0]?.[0].env;
        expect(discoveryEnv?.OPENROUTER_API_KEY).toBe(hostValue ?? "from-config");
        expect(plan.providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
        expect(process.env.OPENROUTER_API_KEY).toBe(hostValue);
      });
    },
  );
});
