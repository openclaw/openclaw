// Exercises startup provider discovery scoping with disposable home and state boundaries.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import {
  prepareProviderExternalAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import {
  prepareSyntheticAuthWithProvider,
  resolveSyntheticAuthWithProvider,
} from "../plugins/provider-synthetic-auth.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { MODELS_CONFIG_IMPLICIT_ENV_VARS } from "./models-config.e2e-harness.js";

const mocks = vi.hoisted(() => ({
  prepareProviderStaticCatalog: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

const BUNDLED_PLUGINS_DIR = fileURLToPath(new URL("../../extensions/", import.meta.url));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
  return {
    ...actual,
    prepareProviderExternalAuthWithPlugin: vi.fn(actual.prepareProviderExternalAuthWithPlugin),
    resolveProviderSyntheticAuthWithPlugin: vi.fn(actual.resolveProviderSyntheticAuthWithPlugin),
  };
});

vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) =>
    result?.providers ??
    (result?.provider
      ? Object.fromEntries(
          [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].map((id) => [
            id.trim().toLowerCase(),
            result.provider,
          ]),
        )
      : {}),
  prepareProviderStaticCatalog: mocks.prepareProviderStaticCatalog,
}));

import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";

function metadataWithOwners(owners: Partial<PluginMetadataSnapshotOwnerMaps>) {
  const snapshot = createPluginMetadataSnapshotFixture();
  return { ...snapshot, owners: { ...snapshot.owners, ...owners } };
}

function createProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createProviderWithStaticCatalog(id: string): ProviderPlugin {
  return {
    ...createProvider(id),
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createStaticOnlyProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
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

describe("resolveImplicitProviders startup discovery scope", () => {
  let state: OpenClawTestState;
  let ambientHome: MockInstance<typeof os.homedir>;

  function discover(
    options: Omit<Parameters<typeof resolveImplicitProviders>[0], "agentDir"> = {},
  ) {
    return resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      ...options,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    state = await createOpenClawTestState({
      label: "provider-discovery-scope",
      env: Object.fromEntries(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "CODEX_API_KEY", "CODEX_HOME", "GOOGLE_CLOUD_API_KEY"]
          .filter((key) => key !== "VITEST" && key !== "NODE_ENV")
          .map((key) => [key, undefined]),
      ),
    });
    // Missing explicit home fields must never reach the operator's OS home.
    // The sentinel keeps a failing isolation regression inside this disposable fixture.
    ambientHome = vi.spyOn(os, "homedir").mockReturnValue(state.path("ambient-home-sentinel"));
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.prepareProviderStaticCatalog.mockResolvedValue({
      providers: [],
      entries: [],
    });
  });

  afterEach(async () => {
    try {
      expect(ambientHome).not.toHaveBeenCalled();
    } finally {
      try {
        await state.cleanup();
      } finally {
        ambientHome.mockRestore();
      }
    }
  });

  it("keeps catalog auth scoped when an ambient credential is present", async () => {
    mocks.runProviderCatalog.mockImplementationOnce(
      async ({
        resolveProviderAuth,
      }: Parameters<typeof import("../plugins/provider-discovery.js").runProviderCatalog>[0]) => {
        expect(resolveProviderAuth("openai")).toMatchObject({
          discoveryApiKey: "scoped-catalog-test-key",
          mode: "api_key",
          source: "env",
        });
        return null;
      },
    );

    await withEnvAsync({ OPENAI_API_KEY: "ambient-catalog-test-key" }, async () => {
      await discover({
        env: { ...state.env, OPENAI_API_KEY: "scoped-catalog-test-key" },
        providerDiscoveryProviderIds: ["openai"],
      });
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledOnce();
  });

  it("loads configured provider entrypoints but runs static hooks only for unresolved refs", async () => {
    const openai = createStaticOnlyProvider("openai");
    const anthropic = createStaticOnlyProvider("anthropic");
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([openai, anthropic]);
    mocks.prepareProviderStaticCatalog.mockResolvedValue({
      providers: [anthropic],
      entries: [],
    });

    const prepared = await prepareImplicitProviderStaticCatalog({
      config: {},
      env: state.env,
      providerDiscoveryProviderIds: ["openai", "anthropic"],
      staticCatalogProviderIds: ["anthropic"],
    });

    expect(mocks.prepareProviderStaticCatalog).toHaveBeenCalledWith({
      providers: [anthropic],
      providerIds: ["anthropic"],
    });
    expect(prepared.providers).toEqual([openai, anthropic]);
  });

  it("prepares a sole family hook for a selected catalog identity", async () => {
    const byteplus = { ...createStaticOnlyProvider("byteplus"), pluginId: "byteplus" };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([byteplus]);

    await prepareImplicitProviderStaticCatalog({
      config: {},
      env: state.env,
      pluginMetadataSnapshot: metadataWithOwners({
        modelCatalogProviders: new Map([["byteplus-plan", ["byteplus"]]]),
      }),
      providerDiscoveryProviderIds: ["byteplus-plan"],
      staticCatalogProviderIds: ["byteplus-plan"],
    });

    expect(mocks.prepareProviderStaticCatalog).toHaveBeenCalledWith({
      providers: [byteplus],
      providerIds: ["byteplus-plan"],
    });
  });

  it("runs only the selected catalog hook within a shared plugin owner", async () => {
    const alpha = { ...createProvider("alpha"), pluginId: "shared" };
    const beta = { ...createProvider("beta"), pluginId: "shared" };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([alpha, beta]);
    mocks.runProviderCatalog.mockImplementation(
      async ({ provider }: { provider: ProviderPlugin }) => ({
        providers: {
          [provider.id]: {
            baseUrl: `https://${provider.id}.example.test`,
            api: "openai-completions",
            models: [],
          },
        },
      }),
    );

    const providers = await discover({
      pluginMetadataSnapshot: metadataWithOwners({
        providers: new Map([
          ["alpha", ["shared"]],
          ["beta", ["shared"]],
        ]),
      }),
      providerDiscoveryProviderIds: ["alpha"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: alpha, providerIds: ["alpha"] }),
    );
    expect(Object.keys(providers ?? {})).toEqual(["alpha"]);
  });

  it.each([
    {
      name: "honors gateway live provider filters",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_GATEWAY_PROVIDERS: "Claude-CLI" },
      owners: { cliBackends: new Map([["claude-cli", ["anthropic"]]]) },
      expected: ["anthropic"],
    },
    {
      name: "keeps explicit plugin-id filters when no owning provider plugin exists",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "openrouter" },
      owners: {},
      expected: ["openrouter"],
    },
  ])("$name", async ({ env, expected, owners }) => {
    await discover({
      env: { ...state.env, VITEST: "1", ...env },
      pluginMetadataSnapshot: metadataWithOwners(owners),
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: expected }),
    );
  });

  it.each(["timeout", "secret-unavailable"] as const)(
    "records every selected family identity after %s without accepting late success",
    async (failure) => {
      const family = createProvider("family");
      const healthy = createProvider("healthy");
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([family, healthy]);
      const completion = createDeferredCore();
      let lateCatalog: Promise<void> | undefined;
      const outcomes: Array<{ provider: string; status: string }> = [];
      mocks.runProviderCatalog.mockImplementation((params) => {
        if (params.provider.id === "healthy") {
          return Promise.resolve({
            provider: {
              baseUrl: "https://healthy.example.test/v1",
              models: [createTextModel("healthy-live", "Healthy live")],
            },
          });
        }
        if (failure === "secret-unavailable") {
          return Promise.reject(
            new SecretSurfaceUnavailableError({
              ownerKind: "provider",
              ownerId: "family",
              state: "unavailable",
              paths: ["models.providers.family.apiKey"],
              refKeys: [],
              reason: "fixture secret is unavailable",
            }),
          );
        }
        lateCatalog = completion.promise.then(() => {
          params.reportCatalogOutcome?.({ provider: "family-plan", status: "ready" });
        });
        return lateCatalog;
      });
      const providers = await discover({
        providerDiscoveryProviderIds: ["family", "family-plan", "healthy"],
        providerDiscoveryTimeoutMs: 1,
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            createPluginManifestRecordFixture({
              id: "family",
              providers: ["family", "family-plan"],
            }),
            createPluginManifestRecordFixture({ id: "healthy", providers: ["healthy"] }),
          ],
        }),
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      });
      const expected = [
        { provider: "family", status: "unavailable" },
        { provider: "family-plan", status: "unavailable" },
      ];
      try {
        expect(providers?.healthy?.models.map((model) => model.id)).toEqual(["healthy-live"]);
        expect(outcomes).toEqual(expected);
      } finally {
        completion.resolve();
        await lateCatalog;
      }
      expect(outcomes).toEqual(expected);
    },
  );

  it("does not fall through to live catalogs when entries-only providers lack static rows", async () => {
    await discover({
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it.each([true])(
    "falls back to static provider catalogs when runtime discovery has no rows (prepared: %s)",
    async (prepared) => {
      const provider = { ...createProviderWithStaticCatalog("minimax"), pluginId: "minimax" };
      const staticConfig: ModelProviderConfig = {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        models: [createTextModel("MiniMax-M2.7", "MiniMax M2.7")],
      };
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
      mocks.runProviderCatalog.mockResolvedValue(null);
      mocks.runProviderStaticCatalog.mockResolvedValue({ providers: { minimax: staticConfig } });

      const providers = await discover({
        providerDiscoveryProviderIds: ["minimax"],
        ...(prepared
          ? {
              preparedStaticProviderCatalog: {
                providers: [provider],
                entries: [
                  {
                    provider,
                    providerConfigs: {
                      minimax: {
                        ...staticConfig,
                        models: [createTextModel("prepared-minimax", "Prepared MiniMax")],
                      },
                    },
                  },
                ],
              },
            }
          : {}),
      });

      expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
      expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(prepared ? 0 : 1);
      expect(providers?.minimax?.models.map((model) => model.id)).toEqual([
        prepared ? "prepared-minimax" : "MiniMax-M2.7",
      ]);
    },
  );
  it.each([
    { scoped: false, api: "openai-responses" as const },
    { scoped: true, api: "openai-responses" as const },
  ])(
    "prepares configured native auth within the discovery scope (scoped: $scoped, api: $api)",
    async ({ scoped, api }) => {
      const prepareNative = vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(
        async () => ({ apiKey: "native-auth-ready", source: "native fixture", mode: "oauth" }),
      );
      const provider: ProviderPlugin = {
        ...createProvider("openai-completions"),
        pluginId: "auth-owner",
        hookAliases: ["openai-responses"],
        prepareSyntheticAuth: prepareNative,
      };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "auth-owner", providers: [provider.id] }],
      });
      const pluginMetadataSnapshot = {
        ...metadata,
        index: {
          ...metadata.index,
          plugins: metadata.index.plugins.map((plugin) =>
            Object.assign({}, plugin, { syntheticAuthRefs: [provider.id] }),
          ),
        },
      };
      const config = {
        models: {
          providers: {
            "custom-native": {
              api,
              baseUrl: "https://native.example.test",
              models: [],
            },
            "unrelated-provider": {
              baseUrl: "https://unrelated.example.test",
              models: [],
            },
          },
        },
      };
      const prepared = vi
        .mocked(prepareProviderExternalAuthWithPlugin)
        .mockImplementation((params) =>
          prepareSyntheticAuthWithProvider(provider, params.context, params),
        );
      const resolved = vi
        .mocked(resolveProviderSyntheticAuthWithPlugin)
        .mockImplementation((params) =>
          resolveSyntheticAuthWithProvider(provider, params.context, params),
        );
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
      let discoveryApiKey: string | undefined;
      mocks.runProviderCatalog.mockImplementationOnce(
        async ({
          resolveProviderAuth,
        }: Parameters<typeof import("../plugins/provider-discovery.js").runProviderCatalog>[0]) => {
          const auth = resolveProviderAuth("custom-native");
          discoveryApiKey = auth.discoveryApiKey;
          return {
            providers: {
              [provider.id]: {
                apiKey: auth.apiKey,
                baseUrl: "https://native.example.test",
                models: [],
              },
            },
          };
        },
      );
      try {
        await resolveImplicitProviders({
          agentDir: state.agentDir(),
          authStore: { version: 1, profiles: {} },
          config,
          env: state.env,
          pluginMetadataSnapshot,
          ...(scoped ? { providerDiscoveryProviderIds: [provider.id] } : {}),
        });
        expect(mocks.runProviderCatalog).toHaveBeenCalledOnce();
        expect(discoveryApiKey).toBe(scoped ? undefined : "native-auth-ready");
        expect(
          prepareNative.mock.calls.filter(([context]) => context.provider === "custom-native"),
        ).toHaveLength(scoped ? 0 : 1);
        expect(prepared.mock.calls.map(([params]) => params.provider)).not.toContain(
          "unrelated-provider",
        );
      } finally {
        prepared.mockRestore();
        resolved.mockRestore();
      }
    },
  );

  it("fills missing static catalog apiKey from Google Vertex ADC auth evidence", async () => {
    const credentialsPath = await state.writeJson("application_default_credentials.json", {
      type: "authorized_user",
    });
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createStaticOnlyProvider("google"),
    ]);
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        "google-vertex": {
          baseUrl: "https://aiplatform.googleapis.com",
          api: "google-vertex" as const,
          models: [createTextModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview")],
        },
      },
    });

    const providers = await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: BUNDLED_PLUGINS_DIR,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () =>
        await resolveImplicitProviders({
          agentDir: state.agentDir(),
          config: {},
          env: {
            ...state.env,
            OPENCLAW_BUNDLED_PLUGINS_DIR: BUNDLED_PLUGINS_DIR,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
            GOOGLE_CLOUD_PROJECT: "vertex-project",
            GOOGLE_CLOUD_LOCATION: "global",
          } as NodeJS.ProcessEnv,
          explicitProviders: {},
          providerDiscoveryEntriesOnly: true,
        }),
    );

    expect(providers?.["google-vertex"]?.apiKey).toBe("gcp-vertex-credentials");
  });

  it("inherits discovered input for a configured model whose source row omitted it", async () => {
    const explicitProvider = {
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "AWS_PROFILE",
      models: [createTextModel("vision-model", "Vision Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProvider("amazon-bedrock"),
    ]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [
          { ...createTextModel("vision-model", "Vision Model"), input: ["text", "image"] },
          createTextModel("discovered-only", "Discovered Only"),
        ],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: { models: { providers: { "amazon-bedrock": explicitProvider } } },
      env: { ...state.env, AWS_PROFILE: "default" },
      explicitProviders: { "amazon-bedrock": explicitProvider },
      sourceModelFields: new Map([
        [
          JSON.stringify(["amazon-bedrock", "vision-model"]),
          { inputOmitted: true, cost: undefined },
        ],
      ]),
    });

    expect(providers?.["amazon-bedrock"]?.models).toMatchObject([
      { id: "vision-model", input: ["text", "image"] },
      { id: "discovered-only" },
    ]);
  });

  it("merges discovered models without treating configured rows or selection policy as inventory limits", async () => {
    const explicitProvider = {
      baseUrl: "http://vllm.example/v1",
      api: "openai-completions" as const,
      models: [createTextModel("manual-model", "Manual Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("vllm")]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "http://vllm.example/v1",
        api: "openai-completions" as const,
        models: [createTextModel("discovered-model", "Discovered Model")],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {
        agents: {
          defaults: {
            models: {
              "vllm/manual-model": {},
            },
          },
        },
        models: {
          providers: {
            vllm: explicitProvider,
          },
        },
      },
      env: state.env,
      explicitProviders: {
        vllm: explicitProvider,
      },
    });

    expect(providers?.vllm?.models.map((model) => model.id)).toEqual([
      "manual-model",
      "discovered-model",
    ]);
  });
  it("reuses prepared static results while preserving the requesting provider scope", async () => {
    const openai = { ...createStaticOnlyProvider("openai"), pluginId: "openai" };
    const anthropic = { ...createStaticOnlyProvider("anthropic"), pluginId: "anthropic" };
    const openaiConfigs: Record<string, ModelProviderConfig> = {
      openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", models: [] },
      unrelated: {
        baseUrl: "https://unrelated.example.test",
        api: "openai-completions",
        models: [],
      },
    };
    const anthropicConfigs: Record<string, ModelProviderConfig> = {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [],
      },
    };
    const providers = await discover({
      explicitProviders: {},
      pluginMetadataSnapshot: metadataWithOwners({
        providers: new Map([
          ["openai", ["openai"]],
          ["anthropic", ["anthropic"]],
        ]),
      }),
      preparedStaticProviderCatalog: {
        providers: [openai, anthropic],
        entries: [
          {
            provider: openai,
            providerConfigs: openaiConfigs,
          },
          {
            provider: anthropic,
            providerConfigs: anthropicConfigs,
          },
        ],
      },
      providerDiscoveryEntriesOnly: true,
      providerDiscoveryProviderIds: ["openai"],
    });

    expect(Object.keys(providers ?? {})).toEqual(["openai"]);
    expect(mocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });
});
