import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";

/** Discovery records the configured rows selected by its provider and hook aliases. */
export type ProviderCatalogInventoryCapture = {
  agentId?: string;
  configuredProviderModelIds: Map<string, readonly string[]>;
};

export function createProviderModelMembership(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  normalizeProvider?: (provider: string) => string;
}): (
  provider: string,
  configuredModelIds: readonly string[] | undefined,
) => ReadonlySet<string> | undefined {
  const normalizeProvider = params.normalizeProvider ?? normalizeProviderId;
  const wildcardProviders = new Set(
    [...parseConfiguredModelVisibilityEntries(params).providerWildcards].map(normalizeProvider),
  );
  return (provider, configuredModelIds) =>
    configuredModelIds?.length && !wildcardProviders.has(normalizeProvider(provider))
      ? new Set(configuredModelIds.map((id) => id.trim()))
      : undefined;
}
