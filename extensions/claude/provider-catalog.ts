import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const CLAUDE_PROVIDER_ID = "claude";
export const CLAUDE_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_APP_SERVER_AUTH_MARKER = "claude-app-server";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high"] as const;

export type ClaudeAppServerModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
};

export const FALLBACK_CLAUDE_MODELS: ClaudeAppServerModel[] = [
  {
    id: "claude-opus-4-7",
    model: "claude-opus-4-7",
    displayName: "Claude Opus 4.7 (1M)",
    description: "Latest Anthropic Opus generation routed through the Claude bridge.",
    isDefault: true,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
  },
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Anthropic Sonnet generation routed through the Claude bridge.",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
  },
  {
    id: "claude-haiku-4-5-20251001",
    model: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    description: "Anthropic Haiku generation routed through the Claude bridge.",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
  },
];

export function buildClaudeModelDefinition(model: ClaudeAppServerModel): ModelDefinitionConfig {
  const id = model.id.trim() || model.model.trim();
  return {
    id,
    name: model.displayName?.trim() || id,
    api: "anthropic-messages",
    reasoning: model.supportedReasoningEfforts.length > 0,
    input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
      supportsUsageInStreaming: true,
    },
  };
}

export function buildClaudeProviderConfig(models: ClaudeAppServerModel[]): ModelProviderConfig {
  return {
    baseUrl: CLAUDE_BASE_URL,
    apiKey: CLAUDE_APP_SERVER_AUTH_MARKER,
    auth: "token",
    api: "anthropic-messages",
    models: models.map(buildClaudeModelDefinition),
  };
}
