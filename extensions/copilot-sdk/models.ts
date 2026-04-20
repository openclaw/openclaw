import type { ModelDefinitionConfig } from "./shared-types.js";

/**
 * Static fallback model catalog used when the Copilot SDK cannot be contacted.
 * Kept intentionally small; the live catalog from `client.listModels()` is
 * preferred whenever it is reachable.
 *
 * Model ids mirror what `@github/copilot` CLI exposes; costs are zeroed since
 * usage is billed against the user's Copilot subscription, not per token.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

export const FALLBACK_MODEL_IDS = [
  "gpt-5",
  "gpt-5-mini",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
] as const;

export function buildFallbackModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { supportsTools: false },
  };
}

export function buildFallbackModelCatalog(): ModelDefinitionConfig[] {
  return FALLBACK_MODEL_IDS.map((id) => buildFallbackModelDefinition(id));
}

/**
 * Converts an SDK-reported model id into an OpenClaw model definition.
 * We intentionally do not import the SDK's `ModelInfo` type here to keep this
 * module side-effect free and easy to test.
 */
export function buildModelDefinitionFromSdk(
  modelId: string,
  displayName?: string,
): ModelDefinitionConfig {
  return {
    id: modelId,
    name: displayName ?? modelId,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { supportsTools: false },
  };
}
