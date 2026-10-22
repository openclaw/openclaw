import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, expect, it as baseIt, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-shared.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawPluginDefinition, ProviderPlugin } from "../plugins/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import { setRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/runtime-snapshots.js";
import { withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

const modelDefaults = { reasoning: false, contextWindow: 8192, maxTokens: 2048 };
const modelFor = (id: string, name = id) => modelDefinition(id, { ...modelDefaults, name });
async function catalogPlan(
  cfg: OpenClawConfig,
  agentDir: string,
  authStore: AuthProfileStore = { version: 1, profiles: {} },
  discoveryAuthConfig = cfg,
) {
  const plan = await planModelsJsonForTest({
    cfg,
    discoveryAuthConfig,
    agentDir,
    env: {},
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "ollama", providers: discovery.providers.map(({ id }) => id) }],
    }),
    authStore,
  });
  const raw = plan.pluginCatalogWrites?.["plugins/ollama/catalog.json"];
  const catalog = JSON.parse(expectDefined(raw, "Ollama writable plugin catalog")) as {
    providers: { ollama: ModelProviderConfig };
  };
  return { plan, catalog: catalog.providers.ollama };
}

const it = baseIt.extend<{ agentDir: string }>({
  agentDir: async ({ task }, use) =>
    withAgentDirEnv(`ollama-catalog-${task.id}-`, (agentDir) =>
      withEnvAsync({ OLLAMA_API_KEY: undefined }, () => use(agentDir)),
    ),
});
beforeAll(async () => {
  const { default: plugin } = await loadBundledPluginFacade<{
    default: OpenClawPluginDefinition;
  }>({ pluginId: "ollama", artifactBasename: "index.js" });
  const register = expectDefined(plugin.register, "Ollama public register");
  register(
    createTestPluginApi({
      id: "ollama",
      registrationMode: "discovery",
      registerProvider: (provider) => {
        if (provider.id === "ollama") {
          discovery.providers.push(provider);
        }
      },
    }),
  );
});
afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.unstubAllGlobals();
});

const remote = "https://ollama-profile.example/v1";
const local = "http://127.0.0.1:11434";
const resolved = "resolved-ollama-profile-fixture";
it.for([
  ["profile", remote, false, resolved],
  ["profile", remote, true, resolved],
  ["profile", local, true, resolved],
  ["config", local, false, "OLLAMA_API_KEY"],
  ["config", local, true, "ollama-local"],
  ["config", "http://127.0.0.1:11435", false, NON_ENV_SECRETREF_MARKER],
] as const)(
  "keeps %s refs out of writable plans at %s (explicit=%s, value=%s)",
  async ([owner, baseUrl, explicitModels, runtimeKey], { agentDir }) => {
    const ref = { source: "store", provider: "default", id: "OLLAMA_DISCOVERY_KEY" } as const;
    const profile = { type: "api_key", provider: "ollama", keyRef: ref } as const;
    const authStore: AuthProfileStore = { version: 1, profiles: {} };
    if (owner === "profile") {
      authStore.profiles["ollama:fixture"] = profile;
      prepareSharedAuthStoreOwnershipForNative();
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...authStore,
          profiles: { "ollama:fixture": { ...profile, key: runtimeKey } },
        },
        agentDir,
      );
    }
    const model = modelFor("fixture-model", "Fixture model");
    const provider = { baseUrl, models: explicitModels ? [model] : [] };
    const cfg = providerConfig("ollama", {
      ...provider,
      ...(owner === "config" ? { apiKey: ref } : {}),
    });
    const discoveryAuthConfig: OpenClawConfig =
      owner === "config" ? providerConfig("ollama", { ...provider, apiKey: runtimeKey }) : cfg;
    const authorization: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      const url = input instanceof Request ? input.url : input.toString();
      return Response.json(
        url.endsWith("/api/tags")
          ? { models: [{ name: model.id }] }
          : {
              capabilities: ["completion", "tools"],
              model_info: { "fixture.context_length": 8192 },
            },
      );
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const { plan, catalog } = await catalogPlan(cfg, agentDir, authStore, discoveryAuthConfig);
    // The source-derived marker is not secret material, even with equal bytes.
    if (runtimeKey !== NON_ENV_SECRETREF_MARKER) {
      expect(JSON.stringify(plan)).not.toContain(runtimeKey);
    }
    expect(JSON.stringify(plan)).not.toContain("discoveryApiKey");
    expect(catalog.models.map(({ id }) => id)).toEqual([model.id]);
    expect(catalog.api).toBe("ollama");
    // Explicit local catalogs select synthetic auth before profiles, but do not transmit it.
    const syntheticLocalAuth =
      owner === "profile" && explicitModels && baseUrl.startsWith("http://127.0.0.1");
    expect(catalog.apiKey).toBe(syntheticLocalAuth ? "ollama-local" : NON_ENV_SECRETREF_MARKER);
    expect(authorization).toEqual(
      syntheticLocalAuth ? [null, null] : [`Bearer ${runtimeKey}`, `Bearer ${runtimeKey}`],
    );
  },
);

it("lists chat models pulled after setup, keeps setup model settings, and keeps setup models when listing fails", async ({
  agentDir,
}) => {
  const setupModel = {
    ...modelFor("qwen2.5:0.5b"),
    // Documented workaround for local models that fail on tool schemas.
    compat: { supportsTools: false },
  };
  const cfg = providerConfig("ollama", {
    baseUrl: local,
    api: "ollama",
    apiKey: "ollama-local",
    models: [setupModel],
  });
  let installed: string[] | undefined = [setupModel.id, "qwen3:0.6b", "nomic-embed-text"];
  let tagsRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/api/tags")) {
      tagsRequests += 1;
      return installed
        ? Response.json({ models: installed.map((name) => ({ name })) })
        : new Response("unavailable", { status: 503 });
    }
    return Response.json({
      capabilities: (typeof init?.body === "string" ? init.body : "").includes("nomic-embed")
        ? ["embedding"]
        : ["completion", "tools"],
      model_info: { "general.context_length": 8192 },
    });
  });
  vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
  const listedModels = async () => {
    const { catalog } = await catalogPlan(cfg, agentDir);
    return catalog.models.map(({ id, compat }) => ({ id, compat }));
  };

  expect(await listedModels()).toEqual([
    { id: setupModel.id, compat: { supportsTools: false } },
    { id: "qwen3:0.6b", compat: expect.objectContaining({ supportsTools: true }) },
  ]);
  installed = undefined;
  expect(await listedModels()).toEqual([{ id: setupModel.id, compat: { supportsTools: false } }]);
  expect(tagsRequests).toBe(2);
});
