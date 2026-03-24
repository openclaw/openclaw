import type { ModelDefinitionConfig } from "../config/types.models.js";

export const NOVITA_BASE_URL = "https://api.novita.ai/openai";

/**
 * Static seed catalog — used as a fallback while the dynamic API fetch is
 * in-flight. Once the Novita API responds, the full 90+ model catalog
 * replaces this list. Pricing uses real API data (1/10000 USD per M tokens).
 */
export const NOVITA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "zai-org/glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202800,
    maxTokens: 131072,
    cost: { input: 1, output: 3.2, cacheRead: 0, cacheWrite: 0 },
  },
];

export function buildNovitaModelDefinition(
  model: (typeof NOVITA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
