import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredProviderConfig } from "./embedded-agent-runner/model.configured-overrides.js";
import { normalizeConfiguredProviderModel } from "./embedded-agent-runner/model.registry-resolution.js";
import {
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata,
} from "./embedded-agent-runner/model.static-catalog.js";

/** The snapshot owner prepares this route; standalone callers use the same cold path. */
export function resolveFallbackRateLimitModel(lookup: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
}) {
  return normalizeConfiguredProviderModel({
    ...lookup,
    providerConfig: resolveConfiguredProviderConfig(lookup.cfg, lookup.provider),
    discoveredModel: resolveBundledStaticCatalogModel(lookup),
    manifestAlias: resolveManifestModelCatalogProviderAliasMetadata(lookup),
  });
}
