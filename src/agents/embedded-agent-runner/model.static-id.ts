import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { indexFirstByKey } from "../../shared/dedupe-by-key.js";
import {
  createStaticProviderModelIdNormalizer,
  normalizeStaticProviderModelId,
  type ProviderModelIdNormalizationOptions,
} from "../model-ref-shared.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.types.js";

type StaticModelIdMatchParams = {
  candidateId: string;
  provider: string;
  modelId: string;
  rowProvider?: string;
};

export type StaticModelIdMatcher = (params: StaticModelIdMatchParams) => boolean;

function matchesStaticModelId(
  params: StaticModelIdMatchParams,
  normalizeModelId: (provider: string, model: string) => string,
): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (params.rowProvider && normalizeProviderId(params.rowProvider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeModelId(normalizedProvider, params.candidateId).trim().toLowerCase() ===
    normalizeModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

export function staticModelIdMatches(params: StaticModelIdMatchParams): boolean {
  return matchesStaticModelId(params, normalizeStaticProviderModelId);
}

/** Builds a matcher pinned to one prepared manifest-policy generation. */
export function createStaticModelIdMatcher(
  options: ProviderModelIdNormalizationOptions = {},
): StaticModelIdMatcher {
  const normalizeModelId = createStaticProviderModelIdNormalizer(options);
  return (params) => matchesStaticModelId(params, normalizeModelId);
}

export function createPreparedConfiguredRuntimeModelLookup(
  models: readonly PreparedConfiguredRuntimeModel[],
  metadataSnapshot: PreparedModelRuntimeSnapshot["metadataSnapshot"],
): PreparedModelRuntimeSnapshot["findConfiguredRuntimeModel"] {
  const normalizeModelId = createStaticProviderModelIdNormalizer({
    manifestPlugins: metadataSnapshot,
  });
  const exactKey = (provider: string, modelId: string) =>
    JSON.stringify([normalizeProviderId(provider), modelId]);
  const staticKey = (provider: string, modelId: string) =>
    exactKey(provider, normalizeModelId(provider, modelId).trim().toLowerCase());
  // Logical IDs win before alias equivalence; both indexes keep the first row.
  // Retained snapshots must never borrow a later generation's normalization policy.
  const exact = indexFirstByKey(models, ({ provider, modelId }) => exactKey(provider, modelId));
  const equivalent = indexFirstByKey(models, ({ provider, modelId }) =>
    staticKey(provider, modelId),
  );
  return (provider, modelId) =>
    (exact.get(exactKey(provider, modelId)) ?? equivalent.get(staticKey(provider, modelId)))?.model;
}
