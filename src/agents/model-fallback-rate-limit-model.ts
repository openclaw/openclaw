import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContextState } from "../plugins/runtime/load-context-state.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { resolveConfiguredProviderConfig } from "./embedded-agent-runner/model.configured-overrides.js";
import { normalizeConfiguredProviderModel } from "./embedded-agent-runner/model.registry-resolution.js";
import {
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata,
} from "./embedded-agent-runner/model.static-catalog.js";
import { modelKey } from "./model-ref-shared.js";

/** The registry owns transport-derived health routes for each immutable config snapshot. */
export function resolveFallbackRateLimitModel(lookup: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
}) {
  const config =
    lookup.cfg === getRuntimeConfigSnapshot()
      ? getRuntimeConfigSnapshot({ capture: true })
      : lookup.cfg && isDeeplyFrozenPlainData(lookup.cfg)
        ? lookup.cfg
        : undefined;
  const context = getPluginRuntimeLoadContextState(getPluginRegistryForContext() ?? undefined);
  let models = config && context?.fallbackRateLimitModels?.get(config);
  if (config && context?.fallbackRateLimitModels && !models) {
    models = new Map();
    context.fallbackRateLimitModels.set(config, models);
  }
  const key = modelKey(lookup.provider, lookup.modelId);
  if (models?.has(key)) {
    return models.get(key);
  }
  const model = normalizeConfiguredProviderModel({
    ...lookup,
    providerConfig: resolveConfiguredProviderConfig(lookup.cfg, lookup.provider),
    discoveredModel: resolveBundledStaticCatalogModel(lookup),
    manifestAlias: resolveManifestModelCatalogProviderAliasMetadata(lookup),
  });
  models?.set(key, model);
  return model;
}
