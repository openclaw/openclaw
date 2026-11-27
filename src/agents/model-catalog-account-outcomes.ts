import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";

// The publication owns the immutable IDs. Only their spelling index is shared across projections.
const normalizedListings = new WeakMap<readonly string[], ReadonlySet<string>>();

function indexListing(ids: readonly string[]): ReadonlySet<string> {
  const existing = normalizedListings.get(ids);
  if (existing) {
    return existing;
  }
  const indexed = new Set<string>();
  for (const id of ids) {
    indexed.add(normalizeLowercaseStringOrEmpty(id));
  }
  normalizedListings.set(ids, indexed);
  return indexed;
}

export function createAccountCatalogOutcomes(initial: readonly ProviderCatalogOutcome[] = []) {
  // Selected-account discovery updates one projection without changing the published inventory.
  const outcomes = [...initial];
  const accountListings = new Map<string, ReadonlySet<string>[]>();
  const keyOf = (provider: string, profileId: string | undefined) =>
    JSON.stringify([provider, profileId]);
  return {
    outcomes,
    accountListsModel: (provider: string, profileId: string | undefined, modelId: string) => {
      const key = keyOf(provider, profileId);
      let listings = accountListings.get(key);
      if (!listings) {
        listings = [];
        for (const outcome of outcomes) {
          if (
            outcome.status === "ready" &&
            outcome.listedModelIds &&
            outcome.profileId === profileId &&
            normalizeProviderId(outcome.provider) === provider
          ) {
            listings.push(indexListing(outcome.listedModelIds));
          }
        }
        accountListings.set(key, listings);
      }
      // A ready empty listing excludes the subscription route. A missing listing supplies no evidence.
      return listings.length ? listings.some((ids) => ids.has(modelId)) : undefined;
    },
    replace(provider: string, profileId: string, next: readonly ProviderCatalogOutcome[]): boolean {
      const matches = (outcome: ProviderCatalogOutcome) =>
        normalizeProviderId(outcome.provider) === provider && outcome.profileId === profileId;
      const previous = outcomes.filter(matches);
      if (previous.length === next.length && previous.every((outcome, i) => outcome === next[i])) {
        return false;
      }
      outcomes.splice(
        0,
        outcomes.length,
        ...outcomes.filter((outcome) => !matches(outcome)),
        ...next,
      );
      accountListings.delete(keyOf(provider, profileId));
      return true;
    },
  };
}
