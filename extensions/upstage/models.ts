import {
  DEFAULT_CONTEXT_TOKENS,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const UPSTAGE_BASE_URL = "https://api.upstage.ai/v1";
export const UPSTAGE_DEFAULT_MODEL_REF = "upstage/solar-pro3";

export const UPSTAGE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "solar-mini",
    name: "Solar Mini",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: 8192,
    // Upstage's pricing page shows a single input price card for Solar Mini,
    // and the embedded calculator exposes a distinct output rate.
    cost: { input: 0.15, output: 0.9, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "solar-pro2",
    name: "Solar Pro 2",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: 8192,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  },
  {
    id: "solar-pro3",
    name: "Solar Pro 3",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: 8192,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  },
];

export function buildUpstageModelDefinition(
  model: (typeof UPSTAGE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return { ...model };
}
