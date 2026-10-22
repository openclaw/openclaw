import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import { createBundledStaticCatalogModelResolver } from "./embedded-agent-runner/model.static-catalog.js";

/**
 * Facts a bundled first-party catalog declares about the model itself. Route facts
 * (endpoint, store, prompt cache, strict tools, tiers) stay with the serving route.
 */
export type BundledModelIdentityFacts = {
  compat?: Pick<ModelCompatConfig, "codeMode" | "supportsTemperature">;
  mediaInput?: ModelMediaInputConfig;
};

export type BundledModelIdentityLookup = {
  /** Bundled catalog provider that serves the upstream model first-party. */
  provider: string;
  /** Wire API of the routed row; facts never cross request formats. */
  api: ModelApi;
  /** Exact upstream model id. */
  modelId: string;
};

/**
 * Looks up model-identity facts for rows that reach a bundled provider's model through
 * another route. Matching is exact: aliases, unknown and future ids inherit nothing.
 * Plugin enablement does not matter; the manifest describes the upstream model.
 */
export function createBundledModelIdentityFactsResolver(): (
  lookup: BundledModelIdentityLookup,
) => BundledModelIdentityFacts | undefined {
  const resolveModel = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery: true });
  return ({ provider, api, modelId }) => {
    const model = resolveModel({ provider, modelId });
    if (
      !model ||
      model.provider !== normalizeProviderId(provider) ||
      model.id !== modelId ||
      model.api !== api
    ) {
      return undefined;
    }
    const { codeMode, supportsTemperature } = model.compat ?? {};
    const compat = {
      ...(codeMode !== undefined ? { codeMode } : {}),
      ...(supportsTemperature !== undefined ? { supportsTemperature } : {}),
    };
    const facts: BundledModelIdentityFacts = {
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      ...(model.mediaInput ? { mediaInput: model.mediaInput } : {}),
    };
    return Object.keys(facts).length > 0 ? facts : undefined;
  };
}
