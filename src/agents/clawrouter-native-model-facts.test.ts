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
import { isCodeModeEngagedForModel, resolveCodeModeConfig } from "./code-mode-runtime.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "./embedded-agent-runner/model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { resolveImageCompressionModelPolicy } from "./image-compression-policy.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { ModelRegistry } from "./sessions/model-registry.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

// Real ClawRouter catalog, model registry, provider runtime hooks, and runtime decisions.
// The native side resolves the same model ids through the bundled first-party catalogs.
it("resolves routed GPT and Claude models with the native runtime decisions", async () => {
  const { default: clawrouter } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  await withOpenClawTestState({ label: "clawrouter-native-facts" }, async (state) => {
    const catalogRequests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      catalogRequests.push(new Request(input).url);
      return Response.json({
        providers: [
          catalogProvider("openai", ["gpt-6.1-sol", "gpt-6-unknown"], "llm.responses"),
          catalogProvider(
            "anthropic",
            ["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-6"],
            "llm.messages",
          ),
        ],
      });
    });
    const credential = "synthetic-clawrouter-native-facts-key";
    // Typical ClawRouter-only setup: a key, the default router origin, no authored routes.
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
      catalogOwner: undefined,
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      activeProjectKeys: [],
      config: cfg,
      observationConfig: cfg,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot,
      pluginRegistry,
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels,
      findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
        configuredRuntimeModels,
        metadataSnapshot,
      ),
      inlineProviderModels: [],
      createStores: () => stores,
    };
    const decisions = async (target: "clawrouter" | "openai" | "anthropic", modelId: string) => {
      const routed = target === "clawrouter";
      const config = routed ? cfg : {};
      const resolved = await resolveModelAsync(target, modelId, state.agentDir(), config, {
        workspaceDir: state.workspaceDir,
        ...(routed ? { preparedModelRuntime } : { skipAgentDiscovery: true }),
        allowBundledStaticCatalogFallback: true,
      });
      if (!resolved.model) {
        throw new Error(`unresolved ${target}/${modelId}: ${resolved.error}`);
      }
      const compat = resolved.model.compat as { supportsTemperature?: boolean } | undefined;
      return {
        codeModeEngaged: isCodeModeEngagedForModel(
          resolveCodeModeConfig(config, "main", { provider: target, modelId }),
          resolved.model,
        ),
        supportsTemperature: compat?.supportsTemperature,
        image: await resolveImageCompressionModelPolicy({
          cfg: config,
          provider: target,
          model: modelId,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          ...(routed ? { preparedModelRuntime } : {}),
        }),
      };
    };

    for (const [nativeProvider, upstream] of [
      ["openai", "gpt-6.1-sol"],
      ["anthropic", "claude-opus-5-5"],
      ["anthropic", "claude-haiku-4-5"],
    ] as const) {
      expect(await decisions("clawrouter", `${nativeProvider}/${upstream}`)).toEqual(
        await decisions(nativeProvider, upstream),
      );
    }
    // Pin the oracle: preferred tiers engage default Code Mode; capable Haiku 4.5 does not.
    expect(await decisions("clawrouter", "openai/gpt-6.1-sol")).toMatchObject({
      codeModeEngaged: true,
      supportsTemperature: false,
    });
    expect(await decisions("clawrouter", "anthropic/claude-opus-5-5")).toMatchObject({
      codeModeEngaged: true,
      image: { maxSidePx: 2576, preferredSidePx: 2576 },
    });
    expect(await decisions("clawrouter", "anthropic/claude-haiku-4-5")).toMatchObject({
      codeModeEngaged: false,
      image: { maxSidePx: 1568 },
    });
    // Unknown ids keep generic defaults instead of borrowing a sibling's facts.
    for (const unknown of ["openai/gpt-6-unknown", "anthropic/claude-opus-6"]) {
      expect(await decisions("clawrouter", unknown)).toEqual({
        codeModeEngaged: false,
        supportsTemperature: undefined,
        image: {},
      });
    }
    // Every routed decision reused the one key-scoped catalog response.
    expect(new Set(catalogRequests)).toEqual(
      new Set(["https://clawrouter.openclaw.ai/v1/catalog"]),
    );
  });
});
