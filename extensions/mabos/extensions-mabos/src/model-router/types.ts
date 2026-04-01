export interface ModelSpec {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  inputPricePer1kTokens: number;
  outputPricePer1kTokens: number;
  supportsPromptCaching?: boolean;
  supportsExtendedThinking?: boolean;
  supportsVision?: boolean;
}

export interface ResolvedModel {
  modelId: string;
  provider: string;
  spec: ModelSpec;
  apiKeyEnv?: string;
}

export interface ModelRouterConfig {
  modelRouterEnabled?: boolean;
  defaultProvider?: string;
  fallbackChain?: string[];
  providers?: Record<string, { baseUrl?: string; apiKeyEnv: string }>;
  promptCaching?: { enabled?: boolean };
  moa?: {
    enabled?: boolean;
    referenceModels?: string[];
    aggregatorModel?: string;
    maxParallelCalls?: number;
  };
}
