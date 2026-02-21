import type { OpenClawConfig } from "openclaw/plugin-sdk";

/**
 * Guardian plugin configuration.
 *
 * The model is specified as "provider/model" (e.g. "kimi/moonshot-v1-8k",
 * "ollama/llama3.1:8b", "openai/gpt-4o-mini") — exactly the same format
 * used for the main agent model in `agents.defaults.model.primary`.
 *
 * The plugin resolves provider baseUrl, apiKey, and API type through
 * OpenClaw's standard model resolution pipeline.
 */
export type GuardianConfig = {
  /**
   * Guardian model in "provider/model" format.
   * Examples: "kimi/moonshot-v1-8k", "ollama/llama3.1:8b", "openai/gpt-4o-mini"
   *
   * If omitted, falls back to the main agent model (agents.defaults.model.primary).
   */
  model?: string;
  /** Tool names that should be reviewed by the guardian */
  watched_tools: string[];
  /** Max wait for guardian API response in milliseconds */
  timeout_ms: number;
  /** Action when guardian API fails or times out */
  fallback_on_error: "allow" | "block";
  /** Log all ALLOW/BLOCK decisions */
  log_decisions: boolean;
  /** enforce = block disallowed calls; audit = log only */
  mode: "enforce" | "audit";
  /** Number of recent user messages to include in guardian prompt */
  max_user_messages: number;
  /** Max characters of tool arguments to include (truncated) */
  max_arg_length: number;
};

/**
 * Resolved model info extracted from OpenClaw's model resolution pipeline.
 * This is what the guardian-client uses to make the actual API call.
 */
export type ResolvedGuardianModel = {
  provider: string;
  modelId: string;
  /** May be undefined at registration time — resolved lazily via SDK. */
  baseUrl?: string;
  apiKey?: string;
  /** Auth mode: "api-key" uses provider-native headers, "oauth"/"token" uses Authorization: Bearer */
  authMode?: "api-key" | "oauth" | "token";
  api: string;
  headers?: Record<string, string>;
};

/**
 * Decision returned by the guardian LLM.
 */
export type GuardianDecision = {
  action: "allow" | "block";
  reason?: string;
};

/**
 * A single turn in the conversation: a user message and the assistant's reply.
 * The assistant reply provides context so the guardian can understand
 * follow-up user messages like "yes", "confirmed", "go ahead".
 */
export type ConversationTurn = {
  user: string;
  assistant?: string;
};

/**
 * Internal representation of cached conversation turns for a session.
 */
export type CachedMessages = {
  /** Recent conversation turns (user message + optional assistant reply). */
  turns: ConversationTurn[];
  updatedAt: number;
};

/** Default configuration values. */
export const GUARDIAN_DEFAULTS = {
  watched_tools: [
    "message_send",
    "message",
    "exec",
    "write_file",
    "Write",
    "gateway",
    "gateway_config",
    "cron",
    "cron_add",
  ],
  timeout_ms: 20000,
  fallback_on_error: "allow" as const,
  log_decisions: true,
  mode: "enforce" as const,
  max_user_messages: 3,
  max_arg_length: 500,
};

/**
 * Resolve a raw plugin config object into a fully-typed GuardianConfig.
 * Applies defaults for any missing fields.
 */
export function resolveConfig(raw: Record<string, unknown> | undefined): GuardianConfig {
  if (!raw) raw = {};

  return {
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    watched_tools: Array.isArray(raw.watched_tools)
      ? (raw.watched_tools as string[])
      : GUARDIAN_DEFAULTS.watched_tools,
    timeout_ms: typeof raw.timeout_ms === "number" ? raw.timeout_ms : GUARDIAN_DEFAULTS.timeout_ms,
    fallback_on_error:
      raw.fallback_on_error === "block" ? "block" : GUARDIAN_DEFAULTS.fallback_on_error,
    log_decisions:
      typeof raw.log_decisions === "boolean" ? raw.log_decisions : GUARDIAN_DEFAULTS.log_decisions,
    mode: raw.mode === "audit" ? "audit" : GUARDIAN_DEFAULTS.mode,
    max_user_messages:
      typeof raw.max_user_messages === "number"
        ? raw.max_user_messages
        : GUARDIAN_DEFAULTS.max_user_messages,
    max_arg_length:
      typeof raw.max_arg_length === "number"
        ? raw.max_arg_length
        : GUARDIAN_DEFAULTS.max_arg_length,
  };
}

/**
 * Parse a "provider/model" string into its parts.
 * Returns undefined if the string is not a valid model reference.
 *
 * Examples:
 *   "kimi/moonshot-v1-8k"  → { provider: "kimi", modelId: "moonshot-v1-8k" }
 *   "ollama/llama3.1:8b"   → { provider: "ollama", modelId: "llama3.1:8b" }
 *   "openai/gpt-4o-mini"   → { provider: "openai", modelId: "gpt-4o-mini" }
 */
export function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= modelRef.length - 1) return undefined;
  const provider = modelRef.slice(0, slashIndex).trim();
  const modelId = modelRef.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

/**
 * Determine the guardian model reference.
 * Priority: plugin config > main agent model.
 */
export function resolveGuardianModelRef(
  config: GuardianConfig,
  openclawConfig?: OpenClawConfig,
): string | undefined {
  // 1. Explicit guardian model in plugin config
  if (config.model) return config.model;

  // 2. Fall back to the main agent model
  const mainModel = openclawConfig?.agents?.defaults?.model;
  if (typeof mainModel === "string") return mainModel;
  if (typeof mainModel === "object" && mainModel?.primary) return mainModel.primary;

  return undefined;
}
