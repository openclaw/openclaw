import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const WAVESPEED_BASE_URL = "https://llm.wavespeed.ai/v1";
export const WAVESPEED_DEFAULT_MODEL_ID = "google/gemini-2.5-flash";
export const WAVESPEED_DEFAULT_MODEL_REF = `wavespeed/${WAVESPEED_DEFAULT_MODEL_ID}`;

// WaveSpeed routes to multiple upstream vendors, so keep the bundled catalog
// pricing neutral until OpenClaw ships a provider-owned public pricing mapping.
const WAVESPEED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const WAVESPEED_MODEL_CATALOG = [
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 1048576,
    maxTokens: 32768,
  },
] as const;

export function buildWaveSpeedModelDefinition(
  model: (typeof WAVESPEED_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: WAVESPEED_DEFAULT_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
