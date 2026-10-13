import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { DEEPSEEK_MODEL_CATALOG } from "./models.js";
import { resolveDeepSeekV4ThinkingProfile } from "./thinking.js";

type CatalogMetadataSnapshot = Pick<ModelDefinitionConfig, "contextWindow" | "cost" | "maxTokens">;

// Onboarding wrote these catalog-owned values into user config in prior releases.
// Refresh only exact matches; any other values remain explicit user overrides.
const PREVIOUS_BUNDLED_METADATA: Record<string, CatalogMetadataSnapshot> = {
  "deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  "deepseek-chat": {
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-reasoner": {
    contextWindow: 131_072,
    maxTokens: 65_536,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasCostValues(cost: unknown): cost is ModelDefinitionConfig["cost"] {
  if (!cost || typeof cost !== "object") {
    return false;
  }
  const c = cost as Record<string, unknown>;
  return (
    typeof c.input === "number" ||
    typeof c.output === "number" ||
    typeof c.cacheRead === "number" ||
    typeof c.cacheWrite === "number"
  );
}

function hasSameCost(left: unknown, right: ModelDefinitionConfig["cost"] | undefined): boolean {
  if (!left || typeof left !== "object" || !right) {
    return false;
  }
  const cost = left as Record<string, unknown>;
  if (Object.hasOwn(cost, "tieredPricing")) {
    return false;
  }
  return (
    cost.input === right.input &&
    cost.output === right.output &&
    cost.cacheRead === right.cacheRead &&
    cost.cacheWrite === right.cacheWrite
  );
}

function isShippedZeroCostAliasSnapshot(
  raw: ModelDefinitionConfig,
  previous: CatalogMetadataSnapshot | undefined,
): boolean {
  return (
    (raw.id === "deepseek-chat" || raw.id === "deepseek-reasoner") &&
    raw.contextWindow === previous?.contextWindow &&
    raw.maxTokens === previous?.maxTokens &&
    hasSameCost(raw.cost, ZERO_COST)
  );
}

function isPreviousBundledMetadataSnapshot(
  raw: ModelDefinitionConfig,
  previous: CatalogMetadataSnapshot | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  return (
    raw.contextWindow === previous.contextWindow &&
    raw.maxTokens === previous.maxTokens &&
    (hasSameCost(raw.cost, previous.cost) || isShippedZeroCostAliasSnapshot(raw, previous))
  );
}

/**
 * Provider policy surface for DeepSeek.
 *
 * Hydrates missing `contextWindow`, `cost`, and `maxTokens` from the bundled
 * catalog for matching model ids. Explicit user overrides are preserved.
 */
export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  const { providerConfig } = params;
  if (!Array.isArray(providerConfig.models) || providerConfig.models.length === 0) {
    return providerConfig;
  }

  const catalog = new Map(DEEPSEEK_MODEL_CATALOG.map((model) => [model.id, model]));
  let mutated = false;

  const nextModels = providerConfig.models.map((model) => {
    const catalogEntry = catalog.get(model.id);
    if (!catalogEntry) {
      return model;
    }
    const hasPreviousBundledMetadata = isPreviousBundledMetadataSnapshot(
      model,
      PREVIOUS_BUNDLED_METADATA[model.id],
    );
    const patched: Partial<ModelDefinitionConfig> = {};

    // Refresh only whole snapshots written by prior releases. A partial match can
    // be an intentional user cap, so per-field refresh would silently erase it.
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (
        (!isPositiveNumber(model[key]) ||
          (hasPreviousBundledMetadata && model[key] !== catalogEntry[key])) &&
        isPositiveNumber(catalogEntry[key])
      ) {
        patched[key] = catalogEntry[key];
      }
    }

    if (
      (!hasCostValues(model.cost) || hasPreviousBundledMetadata) &&
      hasCostValues(catalogEntry.cost) &&
      !hasSameCost(model.cost, catalogEntry.cost)
    ) {
      patched.cost = catalogEntry.cost;
    }

    if (Object.keys(patched).length === 0) {
      return model;
    }

    mutated = true;
    return { ...model, ...patched };
  });

  if (!mutated) {
    return providerConfig;
  }

  return { ...providerConfig, models: nextModels };
}

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  return params.provider.trim().toLowerCase() === "deepseek"
    ? resolveDeepSeekV4ThinkingProfile(params.modelId)
    : null;
}
