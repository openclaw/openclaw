import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { buildConfiguredFallbackModel } from "./embedded-agent-runner/model.configured-fallback.js";
import { resolveExplicitModelWithRegistry } from "./embedded-agent-runner/model.registry-resolution.js";
import { resolveManifestModelCatalogProviderAliasMetadata } from "./embedded-agent-runner/model.static-catalog.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { modelKey } from "./model-ref-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  listModelAliasCandidates,
} from "./model-selection-shared.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export function completeConfiguredRuntimeModels(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  modelRegistry: ModelRegistry,
): readonly PreparedConfiguredRuntimeModel[] {
  if (!pluginGeneration.pluginRegistry) {
    return agentFacts.configuredRuntimeModels;
  }
  const { input, configuredModelRefs, configuredRuntimeModels, env } = agentFacts;
  const { config, agentDir, workspaceDir } = input;
  // Both startup and full discovery complete static misses from their captured registry;
  // borrowing an ambient plugin generation would change configured model ownership.
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    () => {
      const existing = new Map(
        configuredRuntimeModels.map((configured) => [
          buildModelCatalogMergeKey(configured.provider, configured.modelId),
          configured,
        ]),
      );
      const completed: PreparedConfiguredRuntimeModel[] = [];
      const seen = new Set<string>();
      for (const ref of configuredModelRefs) {
        const { provider, modelId } = ref;
        const key = buildModelCatalogMergeKey(provider, modelId);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const model =
          existing.get(key)?.model ??
          resolveLoadedProviderRuntimePlugin({
            provider,
            modelId,
            config,
            workspaceDir,
            env,
          })?.resolveDynamicModel?.({
            config,
            agentDir,
            workspaceDir,
            provider,
            modelId,
            modelRegistry,
            providerConfig:
              config.models?.providers?.[provider] ??
              findNormalizedProviderValue(config.models?.providers, provider),
          });
        if (model) {
          completed.push({ ...ref, model });
        }
      }
      return completed;
    },
  );
}

/** Prepare prompt aliases without promoting execution defaults into catalog metadata. */
export function prepareConfiguredModelAliases(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  modelRegistry: ModelRegistry,
  models: readonly PreparedConfiguredRuntimeModel[],
): NonNullable<PreparedModelRuntimeSnapshot["configuredModelAliases"]> {
  const { config, agentId, agentDir, workspaceDir } = agentFacts.input;
  if (listModelAliasCandidates(config, agentId).length === 0) {
    return [];
  }
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    () => {
      const selection = {
        cfg: config,
        agentId,
        allowPluginNormalization: false,
        manifestPlugins: pluginGeneration.pluginMetadataSnapshot.plugins,
      };
      const defaults = resolveDefaultModelForAgent({
        ...selection,
        allowManifestNormalization: false,
      });
      const policy = createModelVisibilityPolicyWithFallbacks({
        ...selection,
        defaultProvider: defaults.provider,
        defaultModel: defaults,
        catalog: [
          ...modelRegistry.getAll().map(modelCatalogRowToEntry),
          ...models.map(({ model }) => modelCatalogRowToEntry(model)),
        ],
        fallbackModels: [],
      });
      const prepared = new Map(
        models.map((entry) => [modelKey(entry.provider, entry.modelId), entry.model]),
      );
      return [...policy.selectionAliasIndex.byAlias.values()].flatMap(({ alias, ref }) => {
        if (!policy.allows(ref)) {
          return [];
        }
        const manifestAlias = resolveManifestModelCatalogProviderAliasMetadata({
          provider: ref.provider,
          modelId: ref.model,
          cfg: config,
          workspaceDir,
        });
        const resolved = resolveExplicitModelWithRegistry({
          provider: ref.provider,
          modelId: ref.model,
          preparedCatalogModel: prepared.get(modelKey(ref.provider, ref.model)),
          modelRegistry,
          cfg: config,
          agentDir,
          workspaceDir,
          manifestAlias,
        });
        const supported = resolved
          ? resolved.kind === "resolved"
          : buildConfiguredFallbackModel({
              provider: ref.provider,
              modelId: ref.model,
              cfg: config,
              agentDir,
              workspaceDir,
              providerMetadataOwners: pluginGeneration.pluginMetadataSnapshot.owners,
              manifestAlias,
            });
        return supported ? [{ alias, ...ref }] : [];
      });
    },
  );
}
