/**
 * Centralised provider capability registry.
 *
 * Consolidates all model/provider-specific capability checks that were
 * previously scattered across:
 *   - src/utils/provider-utils.ts                   (isReasoningTagProvider)
 *   - src/agents/pi-embedded-runner/cache-ttl.ts    (isCacheTtlEligibleProvider)
 *   - src/agents/pi-embedded-runner/extra-params.ts (OpenRouter headers, cacheRetention)
 *   - src/agents/model-compat.ts                    (supportsDeveloperRole)
 *   - src/agents/pi-embedded-runner/google.ts       (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS)
 *   - src/agents/transcript-policy.ts               (resolveTranscriptPolicy)
 *
 * New code should call resolveProviderCapabilities() instead of inspecting
 * provider / modelId strings directly.
 */

import { isAntigravityClaude, isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import { normalizeProviderId } from "./model-selection.js";

// ── Google Tool-Schema Keyword Blacklist ─────────────────────────────────────

/**
 * JSON Schema keywords that Google's Gemini API does not support.
 * Tools targeting Google providers must have these stripped before the request
 * is sent (see sanitizeToolsForGoogle in pi-embedded-runner/google.ts).
 */
export const GOOGLE_UNSUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

// ── OpenRouter Attribution Headers ───────────────────────────────────────────

const OPENROUTER_APP_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
} as const;

const EMPTY_HEADERS: Readonly<Record<string, string>> = {} as const;

// ── Capability Interface ─────────────────────────────────────────────────────

/**
 * Describes what a provider/model combination is capable of and how it expects
 * to receive data.
 *
 * All provider-specific branching should derive from a ProviderCapabilities
 * value rather than directly comparing provider / modelId strings.
 */
export interface ProviderCapabilities {
  // ── Prompt Engineering ──────────────────────────────────────────────────────

  /**
   * How the agent's internal reasoning must be formatted in the text stream.
   *
   * "tags" – Inject <think>…</think><final>…</final> wrapping instructions into
   *          the system prompt (Ollama, Google, MiniMax, …).
   * "none" – No special reasoning-format injection required.
   */
  reasoningFormat: "tags" | "none";

  // ── Tool Schema ─────────────────────────────────────────────────────────────

  /**
   * Set of JSON Schema keywords this provider cannot handle.
   * These must be stripped from tool definitions before sending.
   * null = no restrictions; pass schemas through unmodified.
   */
  toolSchemaUnsupportedKeywords: ReadonlySet<string> | null;

  // ── Prompt Caching ──────────────────────────────────────────────────────────

  /**
   * Provider supports Anthropic-style prompt caching (cache_control markers).
   * Controls both the context-pruning cache-TTL feature and cacheRetention param.
   */
  supportsPromptCache: boolean;

  /**
   * Whether the cacheRetention stream option is forwarded to the API.
   * Subset of supportsPromptCache: only the direct Anthropic provider honours
   * this param. OpenRouter routes Anthropic traffic differently.
   */
  supportsCacheRetentionParam: boolean;

  // ── HTTP Request ────────────────────────────────────────────────────────────

  /**
   * Extra HTTP headers to inject into every streaming request.
   * Empty object means no additional headers.
   */
  extraRequestHeaders: Readonly<Record<string, string>>;

  // ── Model Compat ────────────────────────────────────────────────────────────

  /**
   * Whether the provider's API supports a "developer" role in the message list.
   * false for ZAI and similar non-standard OpenAI-compatible endpoints.
   */
  supportsDeveloperRole: boolean;

  // ── Transcript / History Sanitization ───────────────────────────────────────
  // These fields mirror the TranscriptPolicy type (transcript-policy.ts).
  // Use capabilitiesToTranscriptPolicy() to convert when an explicit
  // TranscriptPolicy is needed.

  /** Whether to strip non-image tool content (full) or only images. */
  sanitizeMode: "full" | "images-only";

  /** Whether to normalise tool-call IDs to the provider's expected format. */
  sanitizeToolCallIds: boolean;

  /**
   * Specific tool-call ID sanitisation mode.
   * "strict9" – Mistral requires exactly 9 alphanumeric characters.
   * "strict"  – Standard cross-provider safe format.
   * null      – No ID sanitisation (provider accepts arbitrary IDs).
   */
  toolCallIdMode: "strict9" | "strict" | null;

  /** Whether to repair orphaned tool-use / tool-result message pairs. */
  repairToolUseResultPairing: boolean;

  /** Whether to preserve thinking-block signatures in the transcript. */
  preserveSignatures: boolean;

  /**
   * Options for sanitising thought signatures in the transcript.
   * null = no signature sanitisation needed.
   */
  sanitizeThoughtSignatures: {
    allowBase64Only: boolean;
    includeCamelCase: boolean;
  } | null;

  /** Whether to validate and normalise Antigravity-Claude thinking blocks. */
  normalizeAntigravityThinkingBlocks: boolean;

  /** Whether to prepend a synthetic user message to satisfy Google turn ordering. */
  applyGoogleTurnOrdering: boolean;

  /** Whether to apply Gemini-specific turn validation rules. */
  validateGeminiTurns: boolean;

  /** Whether to apply Anthropic-specific turn validation rules. */
  validateAnthropicTurns: boolean;

  /** Whether the provider accepts synthetic tool-result messages in history. */
  allowSyntheticToolResults: boolean;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the full capability set for a provider/model combination.
 *
 * This is the single authoritative source for all provider-specific behaviour.
 * Call sites should cache the result when repeated access is needed within a
 * single request lifecycle.
 *
 * @param params.provider  - Provider identifier (e.g. "anthropic", "openai").
 * @param params.modelId   - Model identifier (e.g. "claude-opus-4-6").
 * @param params.modelApi  - Low-level API variant (e.g. "anthropic-messages").
 * @param params.baseUrl   - Optional base URL; used to detect ZAI endpoints.
 */
export function resolveProviderCapabilities(params: {
  provider?: string | null;
  modelId?: string | null;
  modelApi?: string | null;
  baseUrl?: string | null;
}): ProviderCapabilities {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = (params.modelId ?? "").toLowerCase();
  const modelApi = params.modelApi ?? null;

  // ── Provider Classification ─────────────────────────────────────────────

  const isGoogle = isGoogleModelApi(modelApi);

  const isAnthropic = modelApi === "anthropic-messages" || provider === "anthropic";

  // OpenAI: matched by provider string OR (no provider + openai-family modelApi)
  const isOpenAi =
    provider === "openai" ||
    provider === "openai-codex" ||
    (!provider &&
      (modelApi === "openai" ||
        modelApi === "openai-completions" ||
        modelApi === "openai-responses" ||
        modelApi === "openai-codex-responses"));

  const isMistral =
    provider === "mistral" ||
    ["mistral", "mixtral", "codestral", "pixtral", "devstral", "ministral", "mistralai"].some(
      (hint) => modelId.includes(hint),
    );

  const isOpenRouterGemini =
    (provider === "openrouter" || provider === "opencode") && modelId.includes("gemini");

  const isAntigravityClaudeModel = isAntigravityClaude({
    api: modelApi,
    provider,
    modelId: params.modelId ?? undefined,
  });

  // Direct Google providers (used for tool-schema stripping only)
  const isGoogleDirectProvider =
    provider === "google-antigravity" || provider === "google-gemini-cli";

  const isOpenRouter = provider === "openrouter";

  const isMinimax = provider.includes("minimax");

  const isOpenRouterAnthropic =
    isOpenRouter && (params.modelId ?? "").toLowerCase().startsWith("anthropic/");

  // ZAI: identified by provider name or base URL
  const isZai = provider === "zai" || (params.baseUrl ?? "").includes("api.z.ai");

  // ── Prompt Engineering ──────────────────────────────────────────────────

  const reasoningFormat: ProviderCapabilities["reasoningFormat"] =
    provider === "ollama" ||
    provider === "google-gemini-cli" ||
    provider === "google-generative-ai" ||
    provider.includes("google-antigravity") ||
    isMinimax
      ? "tags"
      : "none";

  // ── Tool Schema ─────────────────────────────────────────────────────────

  const toolSchemaUnsupportedKeywords: ProviderCapabilities["toolSchemaUnsupportedKeywords"] =
    isGoogleDirectProvider ? GOOGLE_UNSUPPORTED_SCHEMA_KEYWORDS : null;

  // ── Prompt Caching ──────────────────────────────────────────────────────

  const supportsPromptCache = provider === "anthropic" || isOpenRouterAnthropic;
  const supportsCacheRetentionParam = provider === "anthropic";

  // ── HTTP Headers ────────────────────────────────────────────────────────

  const extraRequestHeaders: Readonly<Record<string, string>> = isOpenRouter
    ? OPENROUTER_APP_HEADERS
    : EMPTY_HEADERS;

  // ── Model Compat ────────────────────────────────────────────────────────

  const supportsDeveloperRole = !isZai;

  // ── Transcript Sanitization ─────────────────────────────────────────────

  const needsFullSanitize = isGoogle || isAnthropic || isMistral || isOpenRouterGemini;
  const sanitizeMode: "full" | "images-only" = isOpenAi
    ? "images-only"
    : needsFullSanitize
      ? "full"
      : "images-only";

  // Compute raw flag first (mirrors transcript-policy.ts logic for toolCallIdMode)
  const rawSanitizeToolCallIds = isGoogle || isMistral || isAnthropic;
  const sanitizeToolCallIds = !isOpenAi && rawSanitizeToolCallIds;

  // toolCallIdMode mirrors original: derived from raw flag, not the filtered one
  const toolCallIdMode: ProviderCapabilities["toolCallIdMode"] = isMistral
    ? "strict9"
    : rawSanitizeToolCallIds
      ? "strict"
      : null;

  const repairToolUseResultPairing = !isOpenAi && (isGoogle || isAnthropic);

  const sanitizeThoughtSignatures: ProviderCapabilities["sanitizeThoughtSignatures"] =
    !isOpenAi && isOpenRouterGemini ? { allowBase64Only: true, includeCamelCase: true } : null;

  return {
    // Prompt engineering
    reasoningFormat,
    // Tool schema
    toolSchemaUnsupportedKeywords,
    // Caching
    supportsPromptCache,
    supportsCacheRetentionParam,
    // HTTP
    extraRequestHeaders,
    // Compat
    supportsDeveloperRole,
    // Transcript
    sanitizeMode,
    sanitizeToolCallIds,
    toolCallIdMode,
    repairToolUseResultPairing,
    preserveSignatures: isAntigravityClaudeModel,
    sanitizeThoughtSignatures,
    normalizeAntigravityThinkingBlocks: isAntigravityClaudeModel,
    applyGoogleTurnOrdering: !isOpenAi && isGoogle,
    validateGeminiTurns: !isOpenAi && isGoogle,
    validateAnthropicTurns: !isOpenAi && isAnthropic,
    allowSyntheticToolResults: !isOpenAi && (isGoogle || isAnthropic),
  };
}
