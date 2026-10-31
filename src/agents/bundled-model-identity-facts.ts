import { canonicalModelKey } from "@openclaw/model-catalog-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import {
  createBundledStaticCatalogModelResolver,
  listBundledVendorCatalogRows,
} from "./embedded-agent-runner/model.static-catalog.js";

/**
 * Facts a bundled first-party catalog declares about the model itself. Route facts
 * (endpoint, store, prompt cache, strict tools, tiers) stay with the serving route.
 */
export type BundledModelIdentityFacts = {
  compat?: Pick<ModelCompatConfig, "codeMode" | "supportsTemperature">;
  mediaInput?: ModelMediaInputConfig;
  /** Canonical developer lineage the bundled catalog declares for this exact model. */
  family?: string;
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
      ...(model.family ? { family: model.family } : {}),
    };
    return Object.keys(facts).length > 0 ? facts : undefined;
  };
}

/** Model facts every route inherits from the vendor row when its own row does not say. */
type VendorModelFacts = Pick<ModelCompatConfig, "requiresReasoningContentOnAssistantMessages">;

/**
 * Resolves vendor model facts for a route that serves the vendor's model under its own id
 * (an aggregator's vendor-prefixed or dated id maps to the vendor row by canonical key). Only facts about the model
 * itself cross routes, over the same request API; ladders, defaults and wire maps stay with
 * the serving route. Ambiguous canonical keys inherit nothing.
 */
export function createVendorModelFactsResolver(): (route: {
  provider: string;
  id: string;
  api: string;
}) => VendorModelFacts | undefined {
  const resolveModel = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery: true });
  let vendors: Map<string, { provider: string; id: string } | null> | undefined;
  return ({ provider, id, api }) => {
    if (!vendors) {
      vendors = new Map();
      for (const row of listBundledVendorCatalogRows()) {
        const key = canonicalModelKey(row.id);
        vendors.set(key, vendors.has(key) ? null : row);
      }
    }
    const vendor = vendors.get(canonicalModelKey(id));
    if (!vendor || normalizeProviderId(vendor.provider) === normalizeProviderId(provider)) {
      return undefined;
    }
    const model = resolveModel({ provider: vendor.provider, modelId: vendor.id });
    const replay =
      model?.api === api ? model.compat?.requiresReasoningContentOnAssistantMessages : undefined;
    return replay === undefined
      ? undefined
      : { requiresReasoningContentOnAssistantMessages: replay };
  };
}
