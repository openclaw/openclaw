import type {
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
} from "../../llm/types.js";
import type {
  OAuthProviderInterface,
  OAuthLoginCallbacks as ProviderOAuthLoginCallbacks,
} from "../../plugin-sdk/provider-oauth-runtime.js";

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
export interface ProviderModelConfig
  extends
    Pick<
      Model,
      | "id"
      | "name"
      | "reasoning"
      | "thinkingLevelMap"
      | "input"
      | "maxTokens"
      | "headers"
      | "compat"
    >,
    Partial<Pick<Model, "api" | "baseUrl">> {
  /** Cost per token (for tracking, can be 0). */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Maximum context window size in tokens. */
  contextWindow: number;
}

export interface OAuthLoginCallbacks extends ProviderOAuthLoginCallbacks {}

// Provider Registration Types

/** Configuration for registering a provider via api.registerProvider(). */
export interface ProviderConfig extends ProviderConfigBase {
  /** Models to register. If provided, replaces all existing models for this provider. */
  models?: ProviderModelConfig[];
  /** OAuth provider for /login support. The `id` is set automatically from the provider name. */
  oauth?: Pick<OAuthProviderInterface, "login" | "refreshToken" | "getApiKey" | "modifyModels"> & {
    /** Display name for the provider in login UI. */
    name: string;
  };
}
