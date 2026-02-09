/**
 * Model selection and alias resolution.
 * Adapted from OpenClaw src/agents/model-selection.ts
 *
 * Resolves model references like "cloud", "local", "ollama/qwen2.5:3b"
 * to their full provider/model pair.
 */

import type { ModelRef, ModelsRegistry, ModelConfig } from "../types.js";

export type ModelAliasIndex = Map<string, ModelConfig>;

/**
 * Build an alias index from the models registry.
 * Allows lookups like "router" → { provider: "ollama", model: "qwen2.5:3b" }
 */
export function buildModelAliasIndex(registry: ModelsRegistry): ModelAliasIndex {
  const index: ModelAliasIndex = new Map();

  for (const config of Object.values(registry.local)) {
    if (config.alias) {
      index.set(config.alias.toLowerCase(), config);
    }
    const key = `${config.ref.provider}/${config.ref.model}`;
    index.set(key.toLowerCase(), config);
  }

  for (const config of Object.values(registry.cloud)) {
    if (config.alias) {
      index.set(config.alias.toLowerCase(), config);
    }
    const key = `${config.ref.provider}/${config.ref.model}`;
    index.set(key.toLowerCase(), config);
  }

  return index;
}

/**
 * Parse a raw model string into a ModelRef.
 * Accepts: "cloud", "local", "ollama/qwen2.5:3b", "anthropic/claude-opus-4-6"
 */
export function parseModelRef(
  raw: string,
  aliasIndex: ModelAliasIndex,
  defaultProvider: string = "ollama",
): ModelRef | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  // Check alias index first
  const aliased = aliasIndex.get(trimmed);
  if (aliased) {
    return { ...aliased.ref };
  }

  // Parse provider/model format
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { provider: defaultProvider, model: trimmed };
  }

  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }

  return { provider, model };
}

/**
 * Resolve the model to use for a given engine preference.
 * "local" → default local model, "cloud" → default cloud model
 */
export function resolveModelForEngine(
  engine: "local" | "cloud",
  registry: ModelsRegistry,
  aliasIndex: ModelAliasIndex,
): ModelRef {
  const alias = engine === "local" ? registry.defaults.local : registry.defaults.cloud;
  const resolved = aliasIndex.get(alias.toLowerCase());

  if (resolved) {
    return { ...resolved.ref };
  }

  // Fallback: pick first available in the tier
  const tier = engine === "local" ? registry.local : registry.cloud;
  const first = Object.values(tier)[0];
  if (first) {
    return { ...first.ref };
  }

  throw new Error(`No ${engine} models configured`);
}

/**
 * Get the context window size for a resolved model.
 */
export function getModelContextWindow(
  ref: ModelRef,
  aliasIndex: ModelAliasIndex,
  defaultTokens: number = 128_000,
): number {
  const key = `${ref.provider}/${ref.model}`.toLowerCase();
  const config = aliasIndex.get(key);
  return config?.contextWindow ?? defaultTokens;
}
