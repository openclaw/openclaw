import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { CodexAppServerModel } from "./src/app-server/models.js";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_APP_SERVER_AUTH_MARKER = "codex-app-server";

const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
const KNOWN_CODEX_MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-pro": { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
};

export const FALLBACK_CODEX_MODELS = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "gpt-5.5",
    description: "Latest frontier agentic coding model.",
    isDefault: true,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.2",
    model: "gpt-5.2",
    displayName: "gpt-5.2",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
] satisfies CodexAppServerModel[];

export function buildCodexModelDefinition(model: {
  id: string;
  model: string;
  displayName?: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
}): ModelDefinitionConfig {
  const id = model.id.trim() || model.model.trim();
  const normalizedId = id.toLowerCase();
  return {
    id,
    name: model.displayName?.trim() || id,
    api: "openai-codex-responses",
    reasoning: model.supportedReasoningEfforts.length > 0 || shouldDefaultToReasoningModel(id),
    input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: KNOWN_CODEX_MODEL_COSTS[normalizedId] ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
      supportsUsageInStreaming: true,
    },
  };
}

export function buildCodexProviderConfig(models: CodexAppServerModel[]): ModelProviderConfig {
  return {
    baseUrl: CODEX_BASE_URL,
    apiKey: CODEX_APP_SERVER_AUTH_MARKER,
    auth: "token",
    api: "openai-codex-responses",
    models: models.map(buildCodexModelDefinition),
  };
}

function shouldDefaultToReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  );
}
