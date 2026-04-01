import type { ModelSpec } from "./types.js";

const BUILTIN_MODELS: ModelSpec[] = [
  // Anthropic
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 128_000,
    inputPricePer1kTokens: 0.015,
    outputPricePer1kTokens: 0.075,
    supportsPromptCaching: true,
    supportsExtendedThinking: true,
    supportsVision: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 64_000,
    inputPricePer1kTokens: 0.003,
    outputPricePer1kTokens: 0.015,
    supportsPromptCaching: true,
    supportsExtendedThinking: true,
    supportsVision: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_000,
    inputPricePer1kTokens: 0.0008,
    outputPricePer1kTokens: 0.004,
    supportsPromptCaching: true,
    supportsVision: true,
  },
  // OpenAI
  {
    id: "gpt-4.1",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    inputPricePer1kTokens: 0.002,
    outputPricePer1kTokens: 0.008,
    supportsVision: true,
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutput: 16_000,
    inputPricePer1kTokens: 0.0004,
    outputPricePer1kTokens: 0.0016,
    supportsVision: true,
  },
  {
    id: "o3",
    provider: "openai",
    contextWindow: 200_000,
    maxOutput: 100_000,
    inputPricePer1kTokens: 0.01,
    outputPricePer1kTokens: 0.04,
    supportsExtendedThinking: true,
    supportsVision: true,
  },
  {
    id: "o4-mini",
    provider: "openai",
    contextWindow: 200_000,
    maxOutput: 100_000,
    inputPricePer1kTokens: 0.0011,
    outputPricePer1kTokens: 0.0044,
    supportsExtendedThinking: true,
    supportsVision: true,
  },
  // Google
  {
    id: "gemini-2.5-pro",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    inputPricePer1kTokens: 0.00125,
    outputPricePer1kTokens: 0.01,
    supportsVision: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    inputPricePer1kTokens: 0.00015,
    outputPricePer1kTokens: 0.0006,
    supportsVision: true,
  },
  // DeepSeek
  {
    id: "deepseek-r1",
    provider: "deepseek",
    contextWindow: 128_000,
    maxOutput: 8_000,
    inputPricePer1kTokens: 0.00055,
    outputPricePer1kTokens: 0.00219,
    supportsExtendedThinking: true,
  },
  {
    id: "deepseek-v3",
    provider: "deepseek",
    contextWindow: 128_000,
    maxOutput: 8_000,
    inputPricePer1kTokens: 0.00027,
    outputPricePer1kTokens: 0.0011,
  },
];

export class ModelRegistry {
  private models: Map<string, ModelSpec>;

  constructor() {
    this.models = new Map();
    for (const spec of BUILTIN_MODELS) {
      this.models.set(spec.id, spec);
    }
  }

  getSpec(id: string): ModelSpec | undefined {
    return this.models.get(id);
  }

  listModels(): ModelSpec[] {
    return [...this.models.values()];
  }

  listByProvider(provider: string): ModelSpec[] {
    return this.listModels().filter((m) => m.provider === provider);
  }

  /** Estimate cost in USD for a given token usage. */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const spec = this.models.get(modelId);
    if (!spec) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    const inputCost = (inputTokens / 1000) * spec.inputPricePer1kTokens;
    const outputCost = (outputTokens / 1000) * spec.outputPricePer1kTokens;
    return inputCost + outputCost;
  }
}
