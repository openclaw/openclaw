import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginExecutionFrame } from "../plugins/plugin-instance-invocation.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
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
  const context = getPluginRuntimeLoadContext(getPluginRegistryForContext() ?? undefined);
  const scope = getPluginExecutionFrame()?.metadataScope;
  const metadata = scope ? scope.snapshot : getGatewayPluginMetadataSnapshot();
  // A scoped inspection can select another inventory without replacing the active registry.
  const routes =
    metadata && metadata === context?.metadataSnapshot
      ? context.fallbackRateLimitModels
      : undefined;
  let models = config && routes?.get(config);
  if (config && routes && !models) {
    models = new Map();
    routes.set(config, models);
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
