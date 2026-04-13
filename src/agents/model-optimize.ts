/**
 * Model optimization logic: recommends a cheaper model per agent while
 * preserving acceptable execution quality.
 *
 * Tier definitions:
 *   economy  – lowest cost, fast, suitable for simple/routine tasks
 *   standard – mid-tier (default for most agents), good quality/cost balance
 *   premium  – highest capability, highest cost (use only when needed)
 */

import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelCostTier = "economy" | "standard" | "premium";

export type OptimizeResult = {
  /** Fully-qualified provider/model-id string to apply. */
  recommended: string;
  reason: string;
  fromTier: ModelCostTier;
  toTier: ModelCostTier;
};

// Pattern → tier. Matched in order; first match wins.
const TIER_PATTERNS: { pattern: RegExp; tier: ModelCostTier }[] = [
  // Anthropic
  { pattern: /claude.*opus/i, tier: "premium" },
  { pattern: /claude.*sonnet/i, tier: "standard" },
  { pattern: /claude.*haiku/i, tier: "economy" },
  // OpenAI
  { pattern: /o[134]-(pro|preview)/i, tier: "premium" },
  { pattern: /o[134](?!-)/i, tier: "premium" },
  { pattern: /o[134]-mini/i, tier: "standard" },
  { pattern: /gpt-5\.4-mini/i, tier: "economy" },
  { pattern: /gpt-5\.4-nano/i, tier: "economy" },
  { pattern: /gpt-5\.4(?!-(mini|nano))/i, tier: "premium" },
  { pattern: /gpt-4o(?!-mini)/i, tier: "standard" },
  { pattern: /gpt-4o-mini/i, tier: "economy" },
  { pattern: /gpt-4\.5/i, tier: "standard" },
  // Google
  { pattern: /gemini.*ultra/i, tier: "premium" },
  { pattern: /gemini.*pro/i, tier: "standard" },
  { pattern: /gemini.*flash/i, tier: "economy" },
  // Mistral
  { pattern: /mistral.*large/i, tier: "standard" },
  { pattern: /mistral.*small|mistral.*nemo|pixtral.*12b/i, tier: "economy" },
  // Meta / Groq / Others
  { pattern: /llama.*70b|llama.*405b/i, tier: "standard" },
  { pattern: /llama.*8b|llama.*mini/i, tier: "economy" },
  // DeepSeek
  { pattern: /deepseek-r1(?!-lite)/i, tier: "standard" },
  { pattern: /deepseek-r1-lite|deepseek-v3(?!-0324)/i, tier: "economy" },
];

/** Determine which cost tier a model id falls into. */
export function getModelTier(modelId: string): ModelCostTier | null {
  for (const { pattern, tier } of TIER_PATTERNS) {
    if (pattern.test(modelId)) {
      return tier;
    }
  }
  return null;
}

/** Parse "provider/model" into provider and model parts. */
function splitModelRef(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash < 0) {
    return { provider: "", modelId: model };
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function normalizeProvider(provider: string): string {
  return normalizeProviderId(provider);
}

function resolveCatalogProvider(model: string, catalog: ModelCatalogEntry[]): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/")) {
    const { provider, modelId } = splitModelRef(trimmed);
    const normalizedProvider = normalizeProvider(provider);
    return normalizedProvider && modelId.trim() ? normalizedProvider : null;
  }

  const normalized = trimmed.toLowerCase();
  const providers = new Set<string>();
  for (const entry of catalog) {
    if (entry.id.trim().toLowerCase() === normalized || entry.alias?.trim().toLowerCase() === normalized) {
      providers.add(normalizeProvider(entry.provider));
    }
  }

  return providers.size === 1 ? [...providers][0] : null;
}

/** Build the canonical "provider/model" string from a catalog entry. */
function catalogKey(entry: ModelCatalogEntry): string {
  return `${entry.provider}/${entry.id}`;
}

/**
 * Given the current model string and the available model catalog, returns
 * an optimization recommendation (cheaper alternative) or null if the
 * model is already at the economy tier or no suitable alternative exists.
 */
export function getOptimizedModel(
  currentModel: string | null | undefined,
  catalog: ModelCatalogEntry[],
): OptimizeResult | null {
  if (!currentModel) {
    return null;
  }

  const { modelId } = splitModelRef(currentModel.trim());
  const provider = resolveCatalogProvider(currentModel, catalog);
  const currentTier = getModelTier(modelId || currentModel);

  if (!currentTier || currentTier === "economy") {
    // Already the cheapest tier.
    return null;
  }

  if (!provider) {
    // Do not recommend a cross-provider downgrade when the current model ref is ambiguous.
    return null;
  }

  // Target one tier lower.
  const targetTier: ModelCostTier = currentTier === "premium" ? "standard" : "economy";

  // Filter catalog to the same provider (if known) and target tier.
  const providerCatalog = catalog.filter((m) => normalizeProvider(m.provider) === provider);

  const candidates = providerCatalog.filter((m) => getModelTier(m.id) === targetTier);

  if (candidates.length === 0) {
    // Try economy tier if standard had no candidates.
    if (targetTier === "standard") {
      const economyCandidates = providerCatalog.filter((m) => getModelTier(m.id) === "economy");
      if (economyCandidates.length === 0) {
        return null;
      }
      const pick = economyCandidates[economyCandidates.length - 1];
      return {
        recommended: catalogKey(pick),
        reason: buildReason(currentTier, "economy", currentModel, pick.name),
        fromTier: currentTier,
        toTier: "economy",
      };
    }
    return null;
  }

  // Prefer the most recently listed / alphabetically last model in the tier.
  const pick = candidates[candidates.length - 1];
  return {
    recommended: catalogKey(pick),
    reason: buildReason(currentTier, targetTier, currentModel, pick.name),
    fromTier: currentTier,
    toTier: targetTier,
  };
}

function buildReason(
  fromTier: ModelCostTier,
  toTier: ModelCostTier,
  fromModel: string,
  toName: string,
): string {
  const tierLabel = (t: ModelCostTier) =>
    t === "premium" ? "premium" : t === "standard" ? "mid-tier" : "economy";
  return (
    `${toName} is a ${tierLabel(toTier)} model — lower token cost than the ` +
    `${tierLabel(fromTier)} ${fromModel} while maintaining good execution quality for most tasks.`
  );
}

/** Returns true if the model is already at the economy tier (no cheaper option). */
export function isModelAlreadyOptimized(modelId: string | null | undefined): boolean {
  if (!modelId) {
    return false;
  }
  const { modelId: mid } = splitModelRef(modelId.trim());
  return getModelTier(mid || modelId) === "economy";
}
