import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { catalogProvider } from "./clawrouter-catalog.test-support.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "./embedded-agent-runner/model.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const selected = "anthropic/claude-sonnet-4-6";
const baseUrl = "https://clawrouter.example/v1";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

it("does not invent a protocol after ClawRouter loses a selected model across restart", async () => {
  const { default: plugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  await withOpenClawTestState({ label: "clawrouter-catalog-miss" }, async (state) => {
    let listed = true;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        providers: listed
          ? [catalogProvider("anthropic", ["claude-sonnet-4-6"], "llm.messages")]
          : [],
      }),
    );
    const providerConfig: ModelProviderConfig = {
      baseUrl,
      api: "openai-responses",
      apiKey: "synthetic-router-key",
      models: [],
    };
    const config: OpenClawConfig = {
      models: { providers: { clawrouter: providerConfig } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "clawrouter",
          providers: ["clawrouter"],
          rootDir: join(process.cwd(), "extensions/clawrouter"),
        },
      ],
    });
    // Recreate plugin and registry, not just the selected row: a restart has no last-good route.
    const prepare = async (): Promise<PreparedModelRuntimeSnapshot> => {
      const provider = await registerSingleProviderPlugin(plugin);
      const catalog = await provider.catalog?.run({
        config,
        env: {},
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({
          apiKey: "synthetic-router-key",
          discoveryApiKey: "synthetic-router-key",
          mode: "api_key",
          source: "profile",
        }),
        resolveProviderApiKey: () => ({ apiKey: "synthetic-router-key" }),
      });
      if (!catalog || !("provider" in catalog) || !catalog.provider) {
        throw new Error("Missing fixture catalog");
      }
      const stores = createEmptyAgentDiscoveryStores();
      stores.modelRegistry = ModelRegistry.fromCapturedSources(
        stores.authStorage,
        join(state.agentDir(), "models.json"),
        {
          modelsJsonContents: null,
          pluginCatalogs: [],
          staticProviderConfigs: { clawrouter: catalog.provider },
          pluginMetadataSnapshot: metadataSnapshot,
        },
      );
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({ pluginId: "clawrouter", source: "bundled-test", provider });
      return {
        ...createEmptyPreparedModelRuntimeFixture({
          agentDir: state.agentDir(),
          config,
          metadataSnapshot,
          createStores: () => stores,
        }),
        workspaceDir: state.workspaceDir,
        pluginRegistry,
      };
    };
    const resolve = (
      runtime: PreparedModelRuntimeSnapshot,
      allowBundledStaticCatalogFallback = false,
    ) =>
      resolveModelAsync("clawrouter", selected, state.agentDir(), config, {
        preparedModelRuntime: runtime,
        workspaceDir: state.workspaceDir,
        modelIdSource: "selected",
        allowBundledStaticCatalogFallback,
      });
    const original = await prepare();
    const before = await resolve(original);
    expect(before.model).toMatchObject({
      id: selected,
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
    });
    listed = false;
    clearLiveCatalogCacheForTests();
    expect((await resolve(original)).model).toMatchObject({
      id: selected,
      api: "anthropic-messages",
    });
    const restarted = await prepare();
    expect(restarted.createStores().modelRegistry.find("clawrouter", selected)).toBeUndefined();
    // Both ordinary inference and compaction/static-fallback resolution must stop before dispatch.
    for (const staticFallback of [false, true]) {
      await expect(resolve(restarted, staticFallback)).rejects.toThrow(
        /ClawRouter.*not available.*Refresh/u,
      );
    }
    expect(
      fetch.mock.calls.every(([input]) => new Request(input).url.endsWith("/v1/catalog")),
    ).toBe(true);

    // A refresh can recover the same cold runtime; a miss must not become a permanent ban.
    listed = true;
    clearLiveCatalogCacheForTests();
    expect((await resolve(restarted)).model).toMatchObject({
      id: selected,
      api: "anthropic-messages",
    });
    listed = false;
    clearLiveCatalogCacheForTests();

    // A complete operator-authored native route remains valid even with an empty catalog.
    providerConfig.models = [
      {
        id: selected,
        name: "Explicit Claude",
        api: "anthropic-messages",
        baseUrl: "https://clawrouter.example/v1/native/anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 1024,
      },
    ];
    expect((await resolve(await prepare())).model).toMatchObject({
      id: selected,
      api: "anthropic-messages",
    });
  });
});
