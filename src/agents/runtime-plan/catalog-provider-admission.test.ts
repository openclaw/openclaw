import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneConfigWithResolutionFacts,
  resolveConfigProviderUseBindings,
  setConfigProviderUseBindings,
} from "../../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildOpenAICompatibleProviderFamilyCatalog } from "../../plugin-sdk/provider-catalog-live-runtime.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { MODELS_CONFIG_IMPLICIT_ENV_VARS } from "../models-config.e2e-harness.js";
import { planOpenClawModelsJsonSource } from "../models-config.js";
import { planModelsJsonForTest } from "../models-config.plan.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));
vi.mock("../../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  prepareProviderStaticCatalog: vi.fn(async () => ({ providers: [], entries: [] })),
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) =>
    Object.fromEntries(
      ["simple", "profile", "paired", "late"].map((order) => [
        order,
        providers.filter(
          (provider) => ((provider.catalog ?? provider.staticCatalog)?.order ?? "late") === order,
        ),
      ]),
    ),
  normalizePluginDiscoveryResult: ({
    result,
  }: {
    result?: { providers?: Record<string, unknown> } | null;
  }) => result?.providers ?? {},
}));
import { resolveImplicitProviders } from "../models-config.providers.implicit.js";

function createProvider(id: string): ProviderPlugin {
  return { id, label: id, auth: [], catalog: { order: "simple", run: async () => null } };
}
function createTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}
describe("catalog destination credential admission", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.runProviderCatalog.mockReset();
    mocks.runProviderStaticCatalog.mockReset();
    state = await createOpenClawTestState({
      label: "catalog-destination-admission",
      env: Object.fromEntries(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "CODEX_API_KEY", "CODEX_HOME", "GOOGLE_CLOUD_API_KEY"]
          .filter((key) => key !== "VITEST" && key !== "NODE_ENV")
          .map((key) => [key, undefined]),
      ),
    });
  });
  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    await state.cleanup();
  });
  it("revokes earlier provisional output after a later order saves an account while retaining authored and static rows", async () => {
    const first = "fixture-first",
      last = "fixture-last",
      publicId = "fixture-static";
    const env = { ...state.env, SHARED_API_KEY: "environment-account" };
    const source: OpenClawConfig = {
      models: {
        providers: {
          [last]: { baseUrl: "https://fixture.invalid/v1", apiKey: "authored-account", models: [] },
        },
      },
    };
    const binding = {
      apiKey: { source: "env" as const, provider: "default", id: "SHARED_API_KEY" },
    };
    setConfigProviderUseBindings(source, { [first]: binding, [publicId]: binding });
    const config = resolveConfigProviderUseBindings(source);
    const store = ensureAuthProfileStore(state.agentDir(), { config, syncExternalCli: false });
    setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: first,
          providers: [first],
          setup: { providers: [{ id: first, envVars: ["SHARED_API_KEY"] }] },
        },
        { id: last, providers: [last] },
        {
          id: publicId,
          providers: [publicId],
          setup: { providers: [{ id: publicId, envVars: ["SHARED_API_KEY"] }] },
        },
      ],
    });
    const providerConfig = (id: string) => ({
      baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions" as const,
      models: [createTextModel(id, id)],
    });
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProvider(first),
      { ...createProvider(last), catalog: { order: "late", run: async () => null } },
      {
        id: publicId,
        label: publicId,
        auth: [],
        staticCatalog: {
          order: "profile",
          run: async () => ({ providers: { [publicId]: providerConfig("public-model") } }),
        },
      },
    ]);
    mocks.runProviderStaticCatalog.mockImplementation(({ provider }) =>
      provider.staticCatalog.run({}),
    );
    mocks.runProviderCatalog.mockImplementation(async (params) => {
      const id = params.provider.id;
      if (id === last) {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "fixture-first:late": { type: "api_key", provider: first, key: "saved-account" },
          },
        });
      }
      expect(params.resolveProviderApiKey(id).discoveryApiKey).toBe(
        id === first ? "environment-account" : "authored-account",
      );
      params.reportCatalogOutcome?.({ provider: id, status: "ready" });
      return { providers: { [id]: providerConfig(id) } };
    });
    const outcomes: Array<{ provider: string; status: string }> = [];
    const result = await resolveImplicitProviders({
      config,
      env,
      authStore: store,
      agentDir: state.agentDir(),
      pluginMetadataSnapshot: metadata,
      providerDiscoveryProviderIds: [first, last, publicId],
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result?.[first]).toBeUndefined();
    expect(result?.[last]?.models.map((model) => model.id)).toEqual([last]);
    expect(result?.[publicId]?.models.map((model) => model.id)).toEqual(["public-model"]);
    expect(outcomes).toEqual([
      { provider: last, status: "ready" },
      { provider: first, status: "unavailable" },
    ]);
  });

  it.each(["implicit", "provider projection", "runtime source projection"] as const)(
    "does not refresh an authenticated startup catalog after a saved account conflicts through %s",
    async (entryPoint) => {
      const provider = "fixture-startup";
      const env = { ...state.env, FIXTURE_API_KEY: "environment-account" };
      const source = {};
      setConfigProviderUseBindings(source, {
        [provider]: { apiKey: { source: "env", provider: "default", id: "FIXTURE_API_KEY" } },
      });
      const config = resolveConfigProviderUseBindings(source);
      const store = ensureAuthProfileStore(state.agentDir(), { config, syncExternalCli: false });
      setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-startup-plugin",
            providers: [provider],
            setup: { providers: [{ id: provider, envVars: ["FIXTURE_API_KEY"] }] },
          },
        ],
      });
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
        { ...createProvider(provider), pluginId: "fixture-startup-plugin" },
      ]);
      mocks.runProviderCatalog.mockImplementation((params) => {
        expect(params.resolveProviderApiKey(provider).discoveryApiKey).toBe("environment-account");
        params.reportCatalogOutcome?.({ provider, status: "ready" });
        return {
          providers: {
            [provider]: {
              baseUrl: "https://fixture.invalid/v1",
              api: "openai-completions",
              models: [createTextModel("live-startup-model", "Fixture")],
            },
          },
        };
      });
      if (entryPoint === "runtime source projection") {
        setRuntimeConfigSnapshot(config, source);
      }
      const outcomes: Array<{ provider: string; status: string }> = [];
      const options = {
        env,
        authStore: store,
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: [provider],
        onProviderCatalogOutcome: (outcome: { provider: string; status: string }) =>
          outcomes.push(outcome),
      };
      const discover = () =>
        entryPoint === "runtime source projection"
          ? planOpenClawModelsJsonSource(
              cloneConfigWithResolutionFacts(config),
              state.agentDir(),
              options,
            )
          : entryPoint === "provider projection"
            ? planModelsJsonForTest({ cfg: config, agentDir: state.agentDir(), ...options })
            : resolveImplicitProviders({
                config,
                agentDir: state.agentDir(),
                ...options,
              });
      const initial = await discover();
      if (entryPoint === "implicit") {
        expect(initial).toMatchObject({
          [provider]: { models: [expect.objectContaining({ id: "live-startup-model" })] },
        });
      } else {
        expect(JSON.stringify(initial)).toContain("live-startup-model");
      }
      expect(mocks.runProviderCatalog).toHaveBeenCalledOnce();
      expect(outcomes).toEqual([{ provider, status: "ready" }]);
      const retained = mocks.runProviderCatalog.mock.lastCall?.[0];
      if (!retained) {
        throw new Error("Expected the initial catalog owner to run");
      }
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "fixture-startup:late": { type: "api_key", provider, key: "saved-account" },
        },
      });
      expect(() => retained.resolveProviderApiKey(provider)).toThrow(
        "conflicts with saved profile",
      );
      expect(() => retained.resolveProviderAuth(provider)).toThrow("conflicts with saved profile");
      mocks.runProviderCatalog.mockClear();
      outcomes.length = 0;
      const refreshed = await discover();
      if (entryPoint === "implicit") {
        expect(refreshed).toEqual({});
      }
      expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
      expect(outcomes).toEqual([{ provider, status: "unavailable" }]);
      expect(source).toEqual({});
    },
  );
  it.each([
    { sibling: "none", configured: true },
    { sibling: "environment", configured: true },
    { sibling: "profile", configured: true },
    { sibling: "startup-conflict", configured: true },
    { sibling: "environment", configured: false },
  ])(
    "keeps SDK donor auth destination-specific (sibling: $sibling, configured: $configured)",
    async ({ sibling, configured }) => {
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        credentialProviderId: "fixture-donor",
        entries: ["fixture-configured", "fixture-sibling"].map((id) => ({
          id,
          label: id,
          baseUrl: "not-a-url",
          models: [createTextModel("fixture-live", "Fixture live")],
          buildProvider: () => ({
            baseUrl: "not-a-url",
            api: "openai-completions" as const,
            models: [createTextModel("fixture-live", "Fixture live")],
          }),
        })),
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: vi.fn(),
      });
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
        {
          id: "fixture-configured",
          aliases: ["fixture-sibling"],
          pluginId: "fixture-family",
          label: "Fixture family",
          auth: [],
          ...family,
        },
      ]);
      mocks.runProviderCatalog.mockImplementation((params) => family.catalog.run(params));
      mocks.runProviderStaticCatalog.mockResolvedValue({ providers: {} });
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-family",
            providers: ["fixture-configured", "fixture-sibling"],
            setup: { providers: [{ id: "fixture-sibling", envVars: ["FIXTURE_SIBLING_KEY"] }] },
          },
        ],
      });
      const sourceConfig: OpenClawConfig = {
        models: {
          providers: {
            ...(sibling === "startup-conflict"
              ? {}
              : {
                  "fixture-donor": {
                    baseUrl: "https://donor.example",
                    apiKey: "donor-key",
                    models: [],
                  },
                }),
            ...(configured ? { "fixture-configured": { baseUrl: "not-a-url", models: [] } } : {}),
          },
        },
      };
      if (sibling === "startup-conflict") {
        setConfigProviderUseBindings(sourceConfig, {
          "fixture-donor": {
            apiKey: { source: "env", provider: "default", id: "FIXTURE_DONOR_KEY" },
          },
          "fixture-sibling": {
            apiKey: { source: "env", provider: "default", id: "FIXTURE_SIBLING_KEY" },
          },
        });
      }
      const result = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: {
          ...state.env,
          ...(sibling === "environment" ? { FIXTURE_SIBLING_KEY: "sibling-key" } : {}),
          ...(sibling === "startup-conflict"
            ? { FIXTURE_DONOR_KEY: "donor-key", FIXTURE_SIBLING_KEY: "sibling-key" }
            : {}),
        },
        authStore: {
          version: 1,
          ...(sibling === "startup-conflict"
            ? { runtimePersistedProfileIds: ["fixture-sibling:saved", "fixture-donor:saved"] }
            : {}),
          profiles:
            sibling === "profile" || sibling === "startup-conflict"
              ? {
                  "fixture-sibling:saved": {
                    type: "api_key",
                    provider: "fixture-sibling",
                    key: "saved-key",
                  },
                  ...(sibling === "startup-conflict"
                    ? {
                        "fixture-donor:saved": {
                          type: "api_key" as const,
                          provider: "fixture-donor",
                          key: "saved-donor-key",
                        },
                      }
                    : {}),
                }
              : {},
        },
        config: resolveConfigProviderUseBindings(sourceConfig),
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: ["fixture-configured", "fixture-sibling"],
      });
      expect(result?.["fixture-configured"]?.models?.map((model) => model.id)).toEqual(
        configured ? ["fixture-live"] : undefined,
      );
      expect(result?.["fixture-sibling"]).toBeUndefined();
    },
  );

  it.each([true, false])(
    "admits saved family auth only for the requested session destination: %s",
    async (requested) => {
      const config = { agents: { defaults: { model: "test/default" } } };
      const env = { ...state.env, FAMILY_API_KEY: "fixture-env-account" };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "family",
            providers: ["family", "family-plan", "family-other"],
            providerAuthAliases: { "family-plan": "family", "family-other": "family" },
            setup: { providers: [{ id: "family", envVars: ["FAMILY_API_KEY"] }] },
          },
        ],
      });
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
        {
          ...createProvider("family"),
          aliases: ["family-plan", "family-other"],
        },
      ]);
      mocks.runProviderCatalog.mockImplementation((params) => {
        expect(params.resolveProviderApiKey("family-plan").discoveryApiKey).toBe(
          "fixture-saved-account",
        );
        return {
          providers: Object.fromEntries(
            ["family-plan", "family-other"].map((id) => [
              id,
              {
                baseUrl: "https://family.example",
                api: "openai-completions",
                models: [createTextModel("account-only", "Account only")],
              },
            ]),
          ),
        };
      });
      const result = await withPluginMetadataSnapshotScope(
        metadata,
        () =>
          resolveImplicitProviders({
            config,
            env,
            agentDir: state.agentDir(),
            authStore: {
              version: 1,
              profiles: {
                "family:saved": {
                  type: "api_key",
                  provider: "family",
                  key: "fixture-saved-account",
                },
              },
            },
            pluginMetadataSnapshot: metadata,
            providerDiscoveryProviderIds: ["family-plan"],
            requestedProviderIds: requested ? ["family-plan"] : [],
          }),
        { config, env },
      );
      expect(Object.keys(result ?? {})).toEqual(requested ? ["family-plan"] : []);
      expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(requested ? 1 : 0);
    },
  );
});
