import type {
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
} from "../../llm/types.js";

/** Shared fields accepted by extension and registry provider registration. */
export interface ProviderConfigBase {
  /** Display name for the provider in UI. */
  name?: string;
  /** Base URL for the API endpoint. Required when defining models. */
  baseUrl?: string;
  /** API key or environment variable name. Required when defining models (unless oauth provided). */
  apiKey?: string;
  /** API type. Required at provider or model level when defining models. */
  api?: Api;
  /** Optional streamSimple handler for custom APIs. */
  streamSimple?: (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStreamContract;
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
  /** If true, adds Authorization: Bearer header with the resolved API key. */
  authHeader?: boolean;
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
  /** Model ID (e.g., "claude-sonnet-4-20250514"). */
  id: string;
  /** Display name (e.g., "Claude 4 Sonnet"). */
  name: string;
  /** API type override for this model. */
  api?: Api;
  /** API endpoint URL override for this model. */
  baseUrl?: string;
  /** Whether the model supports extended thinking. */
  reasoning: boolean;
  /** Maps OpenClaw thinking levels to provider/model-specific values; null marks a level unsupported. */
  thinkingLevelMap?: Model["thinkingLevelMap"];
  /** Supported input types. */
  input: ("text" | "image")[];
  /** Cost per token (for tracking, can be 0). */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Maximum context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens. */
  maxTokens: number;
  /** Custom headers for this model. */
  headers?: Record<string, string>;
  /** OpenAI compatibility settings. */
  compat?: Model["compat"];
}
