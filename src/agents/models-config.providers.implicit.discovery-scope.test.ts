import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { fetchLiveProviderModelIds } from "../plugin-sdk/provider-catalog-live-runtime.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
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
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
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

// mock-isolation: Scope proofs control provider discovery without loading real provider plugins.
vi.mock("../plugins/provider-discovery.js", () => ({
  ...mocks,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({ simple: providers }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) =>
    result?.providers ??
    (result?.provider ? { [provider.id.trim().toLowerCase()]: result.provider } : {}),
}));

import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";
type CatalogContext = Parameters<
  typeof import("../plugins/provider-discovery.js").runProviderCatalog
>[0];

function metadataWithOwners(owners: Partial<PluginMetadataSnapshotOwnerMaps>) {
  const snapshot = createPluginMetadataSnapshotFixture();
  return { ...snapshot, owners: { ...snapshot.owners, ...owners } };
}

const emptyCatalog = { order: "simple" as const, run: async () => null };
function createProvider(id: string): ProviderPlugin {
  return { id, label: id, auth: [], catalog: emptyCatalog };
}

function createStaticOnlyProvider(id: string): ProviderPlugin {
  return { id, label: id, auth: [], staticCatalog: emptyCatalog };
}

function catalogConfig(
  baseUrl: string,
  models: ModelProviderConfig["models"] = [],
  api?: ModelProviderConfig["api"],
): ModelProviderConfig {
  return { baseUrl, models, ...(api ? { api } : {}) };
}

function createTextModel(id: string, name: string) {
  return modelDefinition(id, { name, reasoning: false, contextWindow: 128000 });
}

let state: OpenClawTestState;
let ambientHome: MockInstance<typeof os.homedir>;

function discover(options: Omit<Parameters<typeof resolveImplicitProviders>[0], "agentDir"> = {}) {
  return resolveImplicitProviders({
    agentDir: state.agentDir(),
    authStore: { version: 1, profiles: {} },
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
  const result = {
    providers: { openai: catalogConfig("https://api.openai.com/v1", [], "openai-responses") },
  };
  mocks.runProviderCatalog.mockResolvedValue(result);
  mocks.runProviderStaticCatalog.mockResolvedValue(result);
  mocks.prepareProviderStaticCatalog.mockResolvedValue({ providers: [], entries: [] });
});

afterEach(async () => {
  try {
    expect(ambientHome).not.toHaveBeenCalled();
  } finally {
    await state.cleanup().finally(() => ambientHome.mockRestore());
  }
});

it("keeps catalog auth scoped when an ambient credential is present", async () => {
  mocks.runProviderCatalog.mockImplementationOnce(
    async ({ resolveProviderAuth }: CatalogContext) => {
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

it("loads configured providers but prepares only unresolved refs", async () => {
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

it("scopes catalog hooks within a shared plugin", async () => {
  const alpha = { ...createProvider("alpha"), pluginId: "shared" };
  const beta = { ...createProvider("beta"), pluginId: "shared" };
  mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([alpha, beta]);
  mocks.runProviderCatalog.mockImplementation(
    async ({ provider }: { provider: ProviderPlugin }) => ({
      providers: {
        [provider.id]: catalogConfig(`https://${provider.id}.example.test`),
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

it.each<[string, NodeJS.ProcessEnv, Partial<PluginMetadataSnapshotOwnerMaps>, string[]]>([
  [
    "gateway CLI owner",
    { OPENCLAW_LIVE_GATEWAY_PROVIDERS: "Claude-CLI" },
    { cliBackends: new Map([["claude-cli", ["anthropic"]]]) },
    ["anthropic"],
  ],
  ["unowned plugin id", { OPENCLAW_LIVE_PROVIDERS: "openrouter" }, {}, ["openrouter"]],
])("filters live discovery by %s", async (_name, env, owners, expected) => {
  await discover({
    env: { ...state.env, VITEST: "1", OPENCLAW_LIVE_TEST: "1", ...env },
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
          { id: "family", providers: ["family", "family-plan"] },
          { id: "healthy", providers: ["healthy"] },
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

it("never runs live catalogs in entries-only mode", async () => {
  await discover({
    providerDiscoveryEntriesOnly: true,
  });

  expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
  expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
});

it("uses prepared static fallback after empty live discovery", async () => {
  const provider = {
    ...createProvider("minimax"),
    staticCatalog: emptyCatalog,
    pluginId: "minimax",
  };
  const staticConfig = catalogConfig(
    "https://api.minimax.io/anthropic",
    [createTextModel("prepared-minimax", "Prepared MiniMax")],
    "anthropic-messages",
  );
  mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
  mocks.runProviderCatalog.mockResolvedValue(null);

  const providers = await discover({
    providerDiscoveryProviderIds: ["minimax"],
    preparedStaticProviderCatalog: {
      providers: [provider],
      entries: [
        {
          provider,
          providerConfigs: { minimax: staticConfig },
        },
      ],
    },
  });

  expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
  expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  expect(providers?.minimax?.models.map((model) => model.id)).toEqual(["prepared-minimax"]);
});
it.each([false, true])("scopes configured native auth (scoped: %s)", async (scoped) => {
  const prepareNative = vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(async () => ({
    apiKey: "native-auth-ready",
    source: "native fixture",
    mode: "oauth",
  }));
  const provider: ProviderPlugin = {
    ...createProvider("openai-completions"),
    pluginId: "auth-owner",
    hookAliases: ["openai-responses"],
    prepareSyntheticAuth: prepareNative,
  };
  const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "auth-owner", providers: [provider.id] }],
  });
  pluginMetadataSnapshot.index.plugins[0]!.syntheticAuthRefs = [provider.id];
  const config = {
    models: {
      providers: {
        "custom-native": catalogConfig("https://native.example.test", [], "openai-responses"),
        "unrelated-provider": catalogConfig("https://unrelated.example.test"),
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
    async ({ resolveProviderAuth }: CatalogContext) => {
      const auth = resolveProviderAuth("custom-native");
      discoveryApiKey = auth.discoveryApiKey;
      return {
        providers: {
          [provider.id]: {
            ...catalogConfig("https://native.example.test"),
            apiKey: auth.apiKey,
          },
        },
      };
    },
  );
  try {
    await discover({
      config,
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
});

it("fills static catalog keys from Vertex ADC", async () => {
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
      await discover({
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

it("inherits discovered input when the configured source omitted it", async () => {
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
      baseUrl: explicitProvider.baseUrl,
      models: [
        { ...createTextModel("vision-model", "Vision Model"), input: ["text", "image"] },
        createTextModel("discovered-only", "Discovered Only"),
      ],
    },
  });
  const providers = await discover({
    config: { models: { providers: { "amazon-bedrock": explicitProvider } } },
    env: { ...state.env, AWS_PROFILE: "default" },
    explicitProviders: { "amazon-bedrock": explicitProvider },
    sourceModelFields: new Map([
      [JSON.stringify(["amazon-bedrock", "vision-model"]), { inputOmitted: true, cost: undefined }],
    ]),
  });
  expect(providers?.["amazon-bedrock"]?.models).toMatchObject([
    { id: "vision-model", input: ["text", "image"] },
    { id: "discovered-only" },
  ]);
});

it("keeps discovered models beyond configured selections", async () => {
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

  const providers = await discover({
    config: {
      agents: { defaults: { models: { "vllm/manual-model": {} } } },
      models: { providers: { vllm: explicitProvider } },
    },
    explicitProviders: { vllm: explicitProvider },
  });

  expect(providers?.vllm?.models.map((model) => model.id)).toEqual([
    "manual-model",
    "discovered-model",
  ]);
});
it("reuses prepared results within provider scope", async () => {
  const openai = { ...createStaticOnlyProvider("openai"), pluginId: "openai" };
  const anthropic = { ...createStaticOnlyProvider("anthropic"), pluginId: "anthropic" };
  const openaiConfigs: Record<string, ModelProviderConfig> = {
    openai: catalogConfig("https://api.openai.com/v1", [], "openai-responses"),
    unrelated: catalogConfig("https://unrelated.example.test", [], "openai-completions"),
  };
  const anthropicConfigs: Record<string, ModelProviderConfig> = {
    anthropic: catalogConfig("https://api.anthropic.com", [], "anthropic-messages"),
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

it.each([
  [0, false],
  [5_000, false],
  [180_000, true],
])(
  "lets a six-second catalog complete only within its %ims acquisition",
  async (timeoutMs, ready) => {
    const fetchGuard = vi.fn(async (request: { timeoutMs?: number; url: string }) => {
      const response = await new Promise<Response>((resolve, reject) => {
        const completion = setTimeout(() => {
          clearTimeout(deadline);
          resolve(new Response(JSON.stringify({ data: [{ id: "slow-healthy" }] })));
        }, 6_000);
        const deadline = setTimeout(() => {
          clearTimeout(completion);
          reject(new Error("catalog transport exceeded its admitted deadline"));
        }, request.timeoutMs);
      });
      return { response, finalUrl: request.url, release: async () => undefined };
    });
    mocks.runProviderCatalog.mockImplementation(async () => {
      const modelIds = await fetchLiveProviderModelIds({
        providerId: "openai",
        endpoint: "https://catalog.example.test/v1/models",
        fetchGuard,
      });
      return {
        providers: {
          openai: catalogConfig(
            "https://catalog.example.test/v1",
            modelIds.map((id) => createTextModel(id, id)),
          ),
        },
      };
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const result = discover({ providerDiscoveryTimeoutMs: timeoutMs });
      await vi.waitFor(() => expect(fetchGuard).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6_100);
      const providers = await result;
      expect(providers?.openai?.models.map((model) => model.id) ?? []).toEqual(
        ready ? ["slow-healthy"] : [],
      );
    } finally {
      vi.useRealTimers();
    }
  },
);
