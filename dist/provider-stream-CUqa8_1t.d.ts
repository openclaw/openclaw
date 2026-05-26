import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { sn as ProviderPlugin } from "./types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region src/agents/pi-embedded-runner/anthropic-family-tool-payload-compat.d.ts
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";
type AnthropicToolPayloadCompatibilityOptions = {
  toolSchemaMode?: AnthropicToolSchemaMode;
  toolChoiceMode?: AnthropicToolChoiceMode;
};
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
declare function createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined, options?: AnthropicToolPayloadCompatibilityOptions): StreamFn;
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
declare function createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
//#endregion
//#region src/agents/pi-embedded-runner/proxy-stream-wrappers.d.ts
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenRouterWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel, extraParams?: Record<string, unknown>): StreamFn;
/** @deprecated Proxy provider-owned stream helper; do not use from third-party plugins. */
declare function isProxyReasoningUnsupported(modelId: string): boolean;
/** @deprecated Kilocode provider-owned stream helper; do not use from third-party plugins. */
declare function createKilocodeWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
//#endregion
//#region src/agents/pi-embedded-runner/minimax-stream-wrappers.d.ts
/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
declare function createMinimaxFastModeWrapper(baseStreamFn: StreamFn | undefined, fastMode: boolean): StreamFn;
//#endregion
//#region src/agents/openai-text-verbosity.d.ts
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
type OpenAITextVerbosity = "low" | "medium" | "high";
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function resolveOpenAITextVerbosity(extraParams: Record<string, unknown> | undefined): OpenAITextVerbosity | undefined;
//#endregion
//#region src/agents/pi-embedded-runner/openai-stream-wrappers.d.ts
type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function resolveOpenAIServiceTier(extraParams: Record<string, unknown> | undefined): OpenAIServiceTier | undefined;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function resolveOpenAIFastMode(extraParams: Record<string, unknown> | undefined): boolean | undefined;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIResponsesContextManagementWrapper(baseStreamFn: StreamFn | undefined, extraParams: Record<string, unknown> | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIReasoningCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIServiceTierWrapper(baseStreamFn: StreamFn | undefined, serviceTier: OpenAIServiceTier): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAITextVerbosityWrapper(baseStreamFn: StreamFn | undefined, verbosity: OpenAITextVerbosity): StreamFn;
/** @deprecated OpenAI Codex provider-owned stream helper; do not use from third-party plugins. */
declare function createCodexNativeWebSearchWrapper(baseStreamFn: StreamFn | undefined, params: {
  config?: OpenClawConfig;
  agentDir?: string;
  codeModeToolSurfaceEnabled?: boolean;
}): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
declare function createOpenAIAttributionHeadersWrapper(baseStreamFn: StreamFn | undefined, opts?: {
  codexNativeTransportStreamFn?: StreamFn;
}): StreamFn;
//#endregion
//#region src/agents/pi-embedded-runner/openrouter-model-capabilities.d.ts
/**
 * Runtime OpenRouter model capability detection.
 *
 * When an OpenRouter model is not in the built-in static list, we look up its
 * actual capabilities from a cached copy of the OpenRouter model catalog.
 *
 * Cache layers (checked in order):
 * 1. In-memory Map (instant, cleared on process restart)
 * 2. On-disk JSON file (<stateDir>/cache/openrouter-models.json)
 * 3. OpenRouter API fetch (populates both layers)
 *
 * Model capabilities are assumed stable — the cache has no TTL expiry.
 * A background refresh is triggered only when a model is not found in
 * the cache (i.e. a newly added model on OpenRouter).
 *
 * Sync callers can read whatever is already cached. Async callers can await a
 * one-time fetch so the first unknown-model lookup resolves with real
 * capabilities instead of the text-only fallback.
 */
interface OpenRouterModelCapabilities {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  supportsTools?: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}
/**
 * Ensure capabilities for a specific model are available before first use.
 *
 * Known cached entries return immediately. Unknown entries wait for at most
 * one catalog fetch, then leave sync resolution to read from the populated
 * cache on the same request.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
declare function loadOpenRouterModelCapabilities(modelId: string): Promise<void>;
/**
 * Synchronously look up model capabilities from the cache.
 *
 * If a model is not found but the cache exists, a background refresh is
 * triggered in case it's a newly added model not yet in the cache.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
declare function getOpenRouterModelCapabilities(modelId: string): OpenRouterModelCapabilities | undefined;
//#endregion
//#region src/plugin-sdk/provider-stream.d.ts
type ProviderStreamFamily = "google-thinking" | "kilocode-thinking" | "moonshot-thinking" | "minimax-fast-mode" | "openai-responses-defaults" | "openrouter-thinking" | "tool-stream-default-on";
type ProviderStreamFamilyHooks = Pick<ProviderPlugin, "wrapStreamFn">;
declare function buildProviderStreamFamilyHooks(family: ProviderStreamFamily): ProviderStreamFamilyHooks;
/** @deprecated Google provider-owned stream hook shortcut; use local provider hooks instead. */
declare const GOOGLE_THINKING_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated Kilocode provider-owned stream hook shortcut; use local provider hooks instead. */
declare const KILOCODE_THINKING_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated Moonshot provider-owned stream hook shortcut; use local provider hooks instead. */
declare const MOONSHOT_THINKING_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated MiniMax provider-owned stream hook shortcut; use local provider hooks instead. */
declare const MINIMAX_FAST_MODE_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated OpenAI provider-owned stream hook shortcut; use local provider hooks instead. */
declare const OPENAI_RESPONSES_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated OpenRouter provider-owned stream hook shortcut; use local provider hooks instead. */
declare const OPENROUTER_THINKING_STREAM_HOOKS: ProviderStreamFamilyHooks;
/** @deprecated Provider-owned stream hook shortcut; use local provider hooks instead. */
declare const TOOL_STREAM_DEFAULT_ON_HOOKS: ProviderStreamFamilyHooks;
//#endregion
export { createMinimaxFastModeWrapper as C, isProxyReasoningUnsupported as D, createOpenRouterWrapper as E, createAnthropicToolPayloadCompatibilityWrapper as O, resolveOpenAITextVerbosity as S, createOpenRouterSystemCacheWrapper as T, createOpenAIResponsesContextManagementWrapper as _, OPENAI_RESPONSES_STREAM_HOOKS as a, resolveOpenAIFastMode as b, TOOL_STREAM_DEFAULT_ON_HOOKS as c, loadOpenRouterModelCapabilities as d, createCodexNativeWebSearchWrapper as f, createOpenAIReasoningCompatibilityWrapper as g, createOpenAIFastModeWrapper as h, MOONSHOT_THINKING_STREAM_HOOKS as i, createOpenAIAnthropicToolPayloadCompatibilityWrapper as k, buildProviderStreamFamilyHooks as l, createOpenAIDefaultTransportWrapper as m, KILOCODE_THINKING_STREAM_HOOKS as n, OPENROUTER_THINKING_STREAM_HOOKS as o, createOpenAIAttributionHeadersWrapper as p, MINIMAX_FAST_MODE_STREAM_HOOKS as r, ProviderStreamFamily as s, GOOGLE_THINKING_STREAM_HOOKS as t, getOpenRouterModelCapabilities as u, createOpenAIServiceTierWrapper as v, createKilocodeWrapper as w, resolveOpenAIServiceTier as x, createOpenAITextVerbosityWrapper as y };