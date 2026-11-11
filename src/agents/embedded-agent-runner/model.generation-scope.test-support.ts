import type { ModelCatalogSuppression } from "@openclaw/model-catalog-core/model-catalog-types";
import { vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createEmptyPreparedModelRuntimeFixture } from "./model.fixture.test-support.js";

type ImagePolicy = NonNullable<NonNullable<ProviderRuntimeModel["mediaInput"]>["image"]>;

export function createModelGenerationFixture(params: {
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  createStores?: PreparedModelRuntimeSnapshot["createStores"];
  label: string;
  modelId?: string;
  prepareDynamicModel?: () => Promise<void>;
  provider?: string;
  requestProvider?: string;
  runtimeApi?: ProviderRuntimeModel["api"];
  runtimeBaseUrl?: string;
  runtimeImagePolicy?: ImagePolicy;
  runtimeAugment?: boolean;
  staticImagePolicy?: ImagePolicy;
  suppression?: Omit<ModelCatalogSuppression, "provider" | "model">;
  withRegistry?: boolean;
}) {
  const { agentDir, config, workspaceDir } = params;
  const provider = params.provider ?? `generation-${params.label}`;
  const requestProvider = params.requestProvider ?? "generation-alias";
  const modelId = params.modelId ?? "generation-model";
  const staticImagePolicy = params.staticImagePolicy ?? {
    maxSidePx: params.label === "a" ? 1_111 : 2_222,
  };
  const plugin = createPluginManifestRecordFixture({
    id: `generation-plugin-${params.label}`,
    enabledByDefault: true,
    providers: [provider],
    modelCatalog: {
      ...(requestProvider === provider ? {} : { aliases: { [requestProvider]: { provider } } }),
      ...(params.runtimeAugment === undefined ? {} : { runtimeAugment: params.runtimeAugment }),
      discovery: { [provider]: "static" },
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: `https://${provider}.example.test/v1`,
          models: [
            {
              id: modelId,
              name: `Static ${params.label.toUpperCase()}`,
              mediaInput: { image: staticImagePolicy },
            },
          ],
        },
      },
      ...(params.suppression
        ? { suppressions: [{ provider, model: modelId, ...params.suppression }] }
        : {}),
    },
  });
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    workspaceDir,
  });
  const pluginRegistry = createEmptyPluginRegistry();
  const resolveDynamicModel = vi.fn(() =>
    makeProviderModelFixture({
      id: modelId,
      name: `Runtime ${params.label.toUpperCase()}`,
      provider,
      api: params.runtimeApi ?? ("openai-completions" as const),
      baseUrl: params.runtimeBaseUrl ?? `https://${provider}.example.test/v1`,
      contextWindow: 8_192,
      maxTokens: 2_048,
      ...(params.runtimeImagePolicy ? { mediaInput: { image: params.runtimeImagePolicy } } : {}),
    }),
  );
  pluginRegistry.providers.push({
    pluginId: plugin.id,
    source: plugin.source,
    provider: {
      id: provider,
      label: `Generation ${params.label.toUpperCase()}`,
      auth: [],
      ...(params.prepareDynamicModel ? { prepareDynamicModel: params.prepareDynamicModel } : {}),
      resolveDynamicModel,
    },
  });
  const preparedModelRuntime = {
    ...createEmptyPreparedModelRuntimeFixture({
      agentDir,
      config,
      metadataSnapshot,
      createStores:
        params.createStores ??
        (() => {
          const authStorage = AuthStorage.inMemory({});
          return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
        }),
    }),
    workspaceDir,
    ...(params.withRegistry === false ? {} : { pluginRegistry }),
  } satisfies PreparedModelRuntimeSnapshot;
  return {
    metadataSnapshot,
    modelId,
    pluginRegistry,
    preparedModelRuntime,
    provider,
    requestProvider,
    resolveDynamicModel,
    runtimeImagePolicy: params.runtimeImagePolicy,
    staticImagePolicy,
  };
}

export function publishCurrentModelGeneration({
  metadataSnapshot,
  pluginRegistry,
  provider,
  preparedModelRuntime: { config, workspaceDir },
}: ReturnType<typeof createModelGenerationFixture>): void {
  setCurrentPluginMetadataSnapshot(metadataSnapshot, { config, workspaceDir });
  setActivePluginRegistry(pluginRegistry, `generation-${provider}`, "default", workspaceDir);
}

export function resetModelGenerationFixtureState(): void {
  setCurrentPluginMetadataSnapshot(undefined);
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
}
