/**
 * Model capabilities registry and filtering utilities.
 * Provides classification of models by their capabilities for dynamic selection.
 */

import type { ModelCatalogEntry } from "./model-catalog.js";

export type ModelCapability = "coding" | "reasoning" | "vision" | "general" | "fast" | "creative";

export type PerformanceTier = "fast" | "balanced" | "powerful";

export type CostTier = "free" | "cheap" | "moderate" | "expensive";

export type ModelCapabilities = {
  coding: boolean;
  reasoning: boolean;
  vision: boolean;
  general: boolean;
  fast: boolean;
  creative: boolean;
  performanceTier: PerformanceTier;
  costTier: CostTier;
};

/**
 * Registry of known model capabilities.
 * Keys should match model IDs as they appear in the catalog (without provider prefix).
 */
export const MODEL_CAPABILITIES_REGISTRY: Record<string, Partial<ModelCapabilities>> = {
  // Anthropic
  "claude-opus-4-5": {
    coding: true,
    reasoning: true,
    vision: true,
    general: true,
    creative: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },
  "claude-sonnet-4-5": {
    coding: true,
    reasoning: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "claude-3-5-sonnet": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "claude-3-5-sonnet-20241022": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "claude-3-5-haiku": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "claude-3-5-haiku-20241022": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "claude-3-opus": {
    coding: true,
    vision: true,
    general: true,
    creative: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },
  "claude-3-sonnet": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "claude-3-haiku": {
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },

  // OpenAI
  "gpt-4o": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gpt-4o-2024-11-20": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gpt-4o-mini": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "gpt-4o-mini-2024-07-18": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  o1: {
    coding: true,
    reasoning: true,
    general: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },
  "o1-2024-12-17": {
    coding: true,
    reasoning: true,
    general: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },
  "o1-mini": {
    coding: true,
    reasoning: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "o1-mini-2024-09-12": {
    coding: true,
    reasoning: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "o1-preview": {
    coding: true,
    reasoning: true,
    general: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },
  "o3-mini": {
    coding: true,
    reasoning: true,
    fast: true,
    performanceTier: "fast",
    costTier: "moderate",
  },
  "gpt-4-turbo": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gpt-4-turbo-preview": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gpt-4": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gpt-3.5-turbo": {
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },

  // Google
  "gemini-2.0-flash": {
    coding: true,
    fast: true,
    vision: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "gemini-2.0-flash-exp": {
    coding: true,
    fast: true,
    vision: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "gemini-2.0-flash-thinking-exp": {
    coding: true,
    reasoning: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gemini-1.5-pro": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gemini-1.5-pro-latest": {
    coding: true,
    vision: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "gemini-1.5-flash": {
    coding: true,
    fast: true,
    vision: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "gemini-1.5-flash-latest": {
    coding: true,
    fast: true,
    vision: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "gemini-exp-1206": {
    coding: true,
    vision: true,
    general: true,
    reasoning: true,
    performanceTier: "powerful",
    costTier: "expensive",
  },

  // Groq (fast inference)
  "llama-3.3-70b-versatile": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "llama-3.1-70b-versatile": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "llama-3.1-8b-instant": {
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "llama3-70b-8192": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "llama3-8b-8192": {
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "mixtral-8x7b-32768": {
    coding: true,
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },

  // Mistral
  "mistral-large-latest": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "mistral-large-2411": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "mistral-medium-latest": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "mistral-small-latest": {
    fast: true,
    general: true,
    performanceTier: "fast",
    costTier: "cheap",
  },
  "codestral-latest": {
    coding: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "codestral-2405": {
    coding: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },

  // DeepSeek
  "deepseek-chat": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },
  "deepseek-coder": {
    coding: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },
  "deepseek-reasoner": {
    coding: true,
    reasoning: true,
    general: true,
    performanceTier: "powerful",
    costTier: "moderate",
  },

  // xAI
  "grok-2": {
    coding: true,
    general: true,
    creative: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "grok-2-vision": {
    coding: true,
    vision: true,
    general: true,
    creative: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "grok-beta": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },

  // Cohere
  "command-r-plus": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "moderate",
  },
  "command-r": {
    general: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },

  // Together AI / Open source
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": {
    coding: true,
    general: true,
    performanceTier: "powerful",
    costTier: "moderate",
  },
  "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },
  "Qwen/Qwen2.5-72B-Instruct-Turbo": {
    coding: true,
    general: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },
  "Qwen/Qwen2.5-Coder-32B-Instruct": {
    coding: true,
    performanceTier: "balanced",
    costTier: "cheap",
  },
};

/**
 * Get capabilities for a model by its ID.
 * Falls back to sensible defaults if the model is not in the registry.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const normalized = modelId.trim().toLowerCase();
  // Try exact match first
  let base = MODEL_CAPABILITIES_REGISTRY[modelId];
  // Try normalized match
  if (!base) {
    for (const [key, value] of Object.entries(MODEL_CAPABILITIES_REGISTRY)) {
      if (key.toLowerCase() === normalized) {
        base = value;
        break;
      }
    }
  }
  // Try prefix match for versioned models
  if (!base) {
    for (const [key, value] of Object.entries(MODEL_CAPABILITIES_REGISTRY)) {
      if (normalized.startsWith(key.toLowerCase())) {
        base = value;
        break;
      }
    }
  }

  return {
    coding: base?.coding ?? false,
    reasoning: base?.reasoning ?? false,
    vision: base?.vision ?? false,
    general: base?.general ?? true,
    fast: base?.fast ?? false,
    creative: base?.creative ?? false,
    performanceTier: base?.performanceTier ?? "balanced",
    costTier: base?.costTier ?? "moderate",
  };
}

/**
 * Get capabilities for a model, also considering catalog metadata.
 * Uses catalog's reasoning and input fields when available.
 */
export function getModelCapabilitiesFromCatalog(entry: ModelCatalogEntry): ModelCapabilities {
  const base = getModelCapabilities(entry.id);
  return {
    ...base,
    // Override with catalog data when available
    reasoning: entry.reasoning ?? base.reasoning,
    vision: entry.input?.includes("image") ?? base.vision,
  };
}

/**
 * Filter catalog entries by a specific capability.
 */
export function filterByCapability(
  catalog: ModelCatalogEntry[],
  capability: ModelCapability,
): ModelCatalogEntry[] {
  return catalog.filter((entry) => {
    const caps = getModelCapabilitiesFromCatalog(entry);
    return caps[capability];
  });
}

/**
 * Get models that are good for coding tasks.
 */
export function getCodingModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return filterByCapability(catalog, "coding");
}

/**
 * Get models with extended reasoning capabilities.
 */
export function getReasoningModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return filterByCapability(catalog, "reasoning");
}

/**
 * Get models that support image input.
 */
export function getVisionModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return filterByCapability(catalog, "vision");
}

/**
 * Get models optimized for speed.
 */
export function getFastModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return filterByCapability(catalog, "fast");
}

/**
 * Filter models by performance tier.
 */
export function getModelsByTier(
  catalog: ModelCatalogEntry[],
  tier: PerformanceTier,
): ModelCatalogEntry[] {
  return catalog.filter((entry) => {
    const caps = getModelCapabilitiesFromCatalog(entry);
    return caps.performanceTier === tier;
  });
}

/**
 * Filter models by cost tier.
 */
export function getModelsByCostTier(
  catalog: ModelCatalogEntry[],
  tier: CostTier,
): ModelCatalogEntry[] {
  return catalog.filter((entry) => {
    const caps = getModelCapabilitiesFromCatalog(entry);
    return caps.costTier === tier;
  });
}

/**
 * Derive capability tags from a model's capabilities.
 */
export function getCapabilityTags(entry: ModelCatalogEntry): string[] {
  const caps = getModelCapabilitiesFromCatalog(entry);
  const tags: string[] = [];
  if (caps.coding) {
    tags.push("coding");
  }
  if (caps.reasoning) {
    tags.push("reasoning");
  }
  if (caps.vision) {
    tags.push("vision");
  }
  if (caps.fast) {
    tags.push("fast");
  }
  if (caps.creative) {
    tags.push("creative");
  }
  return tags;
}

/**
 * Enrich catalog entries with capability metadata.
 */
export function enrichCatalogWithCapabilities(
  catalog: ModelCatalogEntry[],
): (ModelCatalogEntry & { capabilities: ModelCapabilities; tags: string[] })[] {
  return catalog.map((entry) => ({
    ...entry,
    capabilities: getModelCapabilitiesFromCatalog(entry),
    tags: getCapabilityTags(entry),
  }));
}
