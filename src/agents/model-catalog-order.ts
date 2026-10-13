import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getRemoteModelCatalogProviderOverlay } from "../model-catalog/remote-overlay.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";

/**
 * Provider catalogs declare models strongest-first. Preserve that owner order
 * after registry/config merges instead of falling back to alphabetical names.
 */
export function assignProviderModelOrder(
  entries: readonly ModelCatalogEntry[],
  existingEntries: readonly ModelCatalogEntry[] = [],
  options: { appendUnknown?: boolean } = {},
): ModelCatalogEntry[] {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const orderByModel = new Map<string, number>();
  const nextOrderByProvider = new Map<string, number>();
  for (const entry of existingEntries) {
    if (entry.providerOrder === undefined) {
      continue;
    }
    const provider = normalizeProviderId(entry.provider);
    const key = keyOf(entry);
    orderByModel.set(key, entry.providerOrder);
    nextOrderByProvider.set(
      provider,
      Math.max(nextOrderByProvider.get(provider) ?? 0, entry.providerOrder + 1),
    );
  }
  return entries.map((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const key = keyOf(entry);
    const existingOrder = orderByModel.get(key);
    if (existingOrder !== undefined) {
      return { ...entry, providerOrder: existingOrder };
    }
    if (options.appendUnknown === false) {
      return entry;
    }
    const providerOrder = nextOrderByProvider.get(provider) ?? 0;
    nextOrderByProvider.set(provider, providerOrder + 1);
    orderByModel.set(key, providerOrder);
    return { ...entry, providerOrder };
  });
}

export function compareModelCatalogEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  return (
    normalizeProviderId(a.provider).localeCompare(normalizeProviderId(b.provider)) ||
    (a.providerOrder ?? Number.MAX_SAFE_INTEGER) - (b.providerOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id) ||
    a.name.localeCompare(b.name)
  );
}

export type ModelPickerRecommendationRank = (
  entry: Pick<ModelCatalogEntry, "provider" | "id">,
) => number | undefined;

/**
 * Ranks a row by its provider's hosted-catalog `recommendedModels`, best first.
 * Ids the provider no longer serves simply never match a row. Create one per
 * synchronous read: identity keys reuse provider policy only for that operation.
 */
export function createModelPickerRecommendationRank(
  config: OpenClawConfig,
): ModelPickerRecommendationRank {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const ranksByProvider = new Map<string, Map<string, number>>();
  return (entry) => {
    const provider = normalizeProviderId(entry.provider);
    let ranks = ranksByProvider.get(provider);
    if (!ranks) {
      ranks = new Map();
      const recommended = getRemoteModelCatalogProviderOverlay(config, provider)?.recommendedModels;
      for (const [rank, id] of (recommended ?? []).entries()) {
        const key = keyOf({ provider, id });
        if (!ranks.has(key)) {
          ranks.set(key, rank);
        }
      }
      ranksByProvider.set(provider, ranks);
    }
    return ranks.size > 0 ? ranks.get(keyOf(entry)) : undefined;
  };
}

/**
 * Picker order: the session's selected row first, then per provider its
 * recommended rows in recommendation order, then the provider-owned remainder.
 */
export function orderModelCatalogForPicker(
  entries: readonly ModelCatalogEntry[],
  selected?: { provider: string; model: string },
  recommendationRank?: ModelPickerRecommendationRank,
): ModelCatalogEntry[] {
  const ordered = entries
    .map((entry) => ({ entry, rank: recommendationRank?.(entry) ?? Number.MAX_SAFE_INTEGER }))
    .toSorted(
      (a, b) =>
        normalizeProviderId(a.entry.provider).localeCompare(
          normalizeProviderId(b.entry.provider),
        ) ||
        a.rank - b.rank ||
        compareModelCatalogEntries(a.entry, b.entry),
    )
    .map(({ entry }) => entry);
  if (selected) {
    const keyOf = createModelCatalogIdentityKeyResolver();
    const selectedKey = keyOf({ provider: selected.provider, id: selected.model });
    const index = ordered.findIndex((entry) => keyOf(entry) === selectedKey);
    if (index > 0) {
      ordered.unshift(...ordered.splice(index, 1));
    }
  }
  return ordered;
}
