import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { catalogProvider } from "./clawrouter-catalog.test-support.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores } from "./embedded-agent-runner/model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { resolveImageCompressionModelPolicy } from "./image-compression-policy.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { ModelRegistry } from "./sessions/model-registry.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

it("resolves routed image limits through the prepared runtime like native models", async () => {
  const { default: clawrouter } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  await withOpenClawTestState({ label: "clawrouter-native-facts" }, async (state) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        providers: [
          catalogProvider("openai", ["gpt-6-unknown"], "llm.responses"),
          catalogProvider(
            "anthropic",
            ["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-6"],
            "llm.messages",
          ),
        ],
      }),
    );
    const credential = "synthetic-clawrouter-native-facts-key";
    const cfg = {
      models: { providers: { clawrouter: { apiKey: credential } } },
    } as unknown as OpenClawConfig;
    const provider = await registerSingleProviderPlugin(clawrouter);
    const catalog = await provider.catalog?.run({
      config: cfg,
      env: {},
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: credential,
        discoveryApiKey: credential,
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({ apiKey: credential, discoveryApiKey: credential }),
    });
    if (!catalog || !("provider" in catalog) || !catalog.provider) {
      throw new Error("Expected a discovered ClawRouter provider");
    }
    // Prepared runtimes pin the bundled manifests, including disabled first-party plugins.
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: ["openai", "anthropic", "clawrouter"].map((pluginId) => {
        const loaded = loadPluginManifest(join(process.cwd(), "extensions", pluginId));
        if (!loaded.ok) {
          throw new Error(loaded.error);
        }
        return loaded.manifest;
      }),
    });
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
    const configuredRuntimeModels = stores.modelRegistry.getAll().map((model) => ({
      provider: "clawrouter",
      modelId: model.id,
      model,
    }));
    const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config: cfg,
        metadataSnapshot,
        createStores: () => stores,
      }),
      agentId: "main",
      workspaceDir: state.workspaceDir,
      pluginRegistry,
      configuredRuntimeModels,
      findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
        configuredRuntimeModels,
        metadataSnapshot,
      ),
    };
    const imagePolicy = (target: "clawrouter" | "anthropic", model: string) =>
      resolveImageCompressionModelPolicy({
        cfg: target === "clawrouter" ? cfg : {},
        provider: target,
        model,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        ...(target === "clawrouter" ? { preparedModelRuntime } : {}),
      });
    for (const upstream of ["claude-opus-5-5", "claude-haiku-4-5"]) {
      expect(await imagePolicy("clawrouter", `anthropic/${upstream}`)).toEqual(
        await imagePolicy("anthropic", upstream),
      );
    }
    expect(await imagePolicy("clawrouter", "anthropic/claude-opus-5-5")).toMatchObject({
      maxSidePx: 2576,
      preferredSidePx: 2576,
    });
    expect(await imagePolicy("clawrouter", "anthropic/claude-haiku-4-5")).toMatchObject({
      maxSidePx: 1568,
    });
    // Unknown ids keep generic defaults instead of borrowing a sibling's facts.
    for (const unknown of ["openai/gpt-6-unknown", "anthropic/claude-opus-6"]) {
      expect(await imagePolicy("clawrouter", unknown)).toEqual({});
    }
  });
});
