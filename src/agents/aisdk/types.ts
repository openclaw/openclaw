/**
 * AI SDK v6 integration types for openclaw.
 * This module defines the core types used by the AI SDK engine.
 */

import type { LanguageModel } from "ai";

/**
 * Provider mode determines how models are accessed:
 * - "gateway": Use Vercel AI Gateway for unified access to all providers
 * - "direct": Use provider-specific SDK packages directly
 */
export type ProviderMode = "gateway" | "direct";

/**
 * Supported AI SDK providers for direct mode.
 */
export type DirectProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "amazon-bedrock"
  | "azure"
  | "groq"
  | "mistral"
  | "xai"
  | "openrouter"
  | "openai-compatible";

/**
 * Model reference in the format "provider/model-id".
 * Examples: "anthropic/claude-sonnet-4", "openai/gpt-4o"
 */
export type ModelRef = `${string}/${string}`;

/**
 * Provider configuration for direct mode.
 */
export interface DirectProviderConfig {
  /** API key for the provider */
  apiKey?: string;
  /** Base URL override for custom endpoints */
  baseUrl?: string;
  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}

/**
 * AI Gateway configuration.
 */
export interface GatewayConfig {
  /** AI Gateway API key */
  apiKey?: string;
  /** Gateway base URL (defaults to Vercel AI Gateway) */
  baseUrl?: string;
}

/**
 * AI SDK engine configuration.
 */
export interface AiSdkConfig {
  /** Provider mode: "gateway" or "direct" */
  mode: ProviderMode;
  /** AI Gateway configuration (when mode is "gateway") */
  gateway?: GatewayConfig;
  /** Direct provider configurations (when mode is "direct") */
  providers?: Partial<Record<DirectProviderId, DirectProviderConfig>>;
  /** Default model to use if not specified */
  defaultModel?: ModelRef;
}

/**
 * Resolved model ready for use with AI SDK.
 */
export interface ResolvedModel {
  /** The AI SDK language model instance */
  model: LanguageModel;
  /** Provider ID */
  providerId: string;
  /** Model ID */
  modelId: string;
  /** Full model reference */
  ref: ModelRef;
}

/**
 * AI SDK stream input parameters.
 * Matches the interface expected by streamText().
 */
export interface AiSdkStreamInput {
  /** Resolved model to use */
  model: ResolvedModel;
  /** System prompt(s) */
  system?: string | string[];
  /** Message history */
  messages: AiSdkMessage[];
  /** Tools available to the model */
  tools?: Record<string, AiSdkTool>;
  /** Temperature for generation */
  temperature?: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Top-p sampling parameter */
  topP?: number;
}

/**
 * AI SDK message format.
 */
export interface AiSdkMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AiSdkMessageContent[];
}

/**
 * AI SDK message content block.
 */
export type AiSdkMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; image: string | Uint8Array; mimeType?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown };

/**
 * AI SDK tool definition.
 */
export interface AiSdkTool {
  description: string;
  parameters: unknown; // JSON Schema
  execute?: (args: unknown) => Promise<unknown>;
}
