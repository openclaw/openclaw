import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function dedupeCatalogScopeRefs(values: Array<string | undefined>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(values);
}

function providerFromModelRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  return provider || undefined;
}

/** Resolves provider/model refs used to scope provider discovery for a selected model. */
export function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): { providerRefs: string[]; modelRefs: string[] } {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const providerConfig = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  return {
    providerRefs: dedupeCatalogScopeRefs([provider, providerConfig?.api]),
    modelRefs: dedupeCatalogScopeRefs([provider && model ? `${provider}/${model}` : model, model]),
  };
}

/** Derives provider ids from explicit provider refs and provider-qualified model refs. */
export function resolveProviderDiscoveryProviderIdsForCatalogScope(params: {
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}): string[] | undefined {
  const providerIds = dedupeCatalogScopeRefs([
    ...(params.providerRefs ?? []),
    ...(params.modelRefs ?? []).map(providerFromModelRef),
  ]);
  return providerIds.length > 0 ? providerIds : undefined;
}
