import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import type { AssistantMessage } from "../types.js";

const CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE =
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i;

const ASSISTANT_OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input length and `?max_tokens`? exceed context limit: [\d,]+ \+ [\d,]+ > [\d,]+/i, // Anthropic direct API
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (all backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /(?:exceeds the available context size|context size has been exceeded)/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /tokens? in request more than max tokens? allowed/i, // Z.AI / Zhipu GLM error 1210
  /prompt exceeds max(?:imum)? length/i, // Z.AI / Zhipu GLM error 1261
  /too large for model with \d+ maximum context length/i, // Mistral
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^413\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 413 with no body
];

const FAILOVER_EXPLICIT_OVERFLOW_PATTERNS = [
  /request_too_large/i, // Anthropic request byte-size overflow
  /context_overflow/i,
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /invalid_argument[\s\S]*maximum number of tokens/i, // Google/Vertex
  /request exceeds the maximum size/i, // Anthropic
  /context length exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /prompt too long/i,
  /exceeds model context window/i,
  /model token limit/i,
  /input exceeds[\s\S]*maximum number of tokens/i,
  /^(?=[\s\S]*context window)(?=[\s\S]*ran out of (?:room|space))/i, // Codex
  /request size exceeds[\s\S]*context window/i,
  /context overflow:/i,
  /exceed context limit/i,
  /exceeds the model'?s maximum context/i,
  /max_tokens[\s\S]*exceed[\s\S]*context/i,
  /input(?: length[\s\S]*exceed[\s\S]*context| \([\d,]+\s*tokens?\) is longer than (?:the )?model'?s context length)/i,
  /413[\s\S]*too large/i,
  /context_window_exceeded/i,
  /input length [\d,]+\s+tokens? exceeds the model limit/i,
  /上下文过长|上下文超出|上下文长度超|超出最大上下文|请压缩上下文/,
];

const PROVIDER_FALLBACK_OVERFLOW_PATTERNS = [
  /\binput token count exceeds the maximum number of input tokens\b/i, // AWS Bedrock
  /\binput is too long for this model\b/i, // AWS Bedrock stream errors
  /\binput exceeds the maximum number of tokens\b/i, // Google Vertex / Gemini
  /\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i, // Cohere
  /\b(?:(?:request|prompt) \(\d[\d,]*\s*tokens?\) exceeds (?:the )?available context size|context size has been exceeded)\b/i, // llama.cpp
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

const CONTEXT_OVERFLOW_PATTERN_SCOPES = {
  "assistant-error": ASSISTANT_OVERFLOW_PATTERNS,
  "failover-explicit": FAILOVER_EXPLICIT_OVERFLOW_PATTERNS,
  "provider-fallback": PROVIDER_FALLBACK_OVERFLOW_PATTERNS,
  "failover-hint": [
    /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i,
  ],
  "context-window-too-small": [/context window.*(too small|minimum is)/i],
  "tpm-rate-limit-hint": [/\btpm\b|tokens per minute/i],
  "rate-limit-hint": [
    /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i,
  ],
} as const;

export type ContextOverflowMessageScope = keyof typeof CONTEXT_OVERFLOW_PATTERN_SCOPES;

/** Match one canonical context-overflow wording scope without applying caller policy. */
export function matchesContextOverflowMessage(
  errorMessage: string,
  scope: ContextOverflowMessageScope,
): boolean {
  return CONTEXT_OVERFLOW_PATTERN_SCOPES[scope].some((pattern: RegExp) =>
    pattern.test(errorMessage),
  );
}

// Bedrock throttling can say "too many tokens" without exhausting the context window.
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

function resolveContextInputTokens(message: AssistantMessage): number | undefined {
  if (message.usage.contextUsage?.state === "available") {
    return message.usage.contextUsage.promptTokens;
  }
  if (message.usage.contextUsage?.state === "unavailable") {
    return undefined;
  }
  // Cache writes are prompt tokens even when providers omit them from `input`.
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

/**
 * Match provider overflow errors, or infer overflow from reported context usage.
 * A context window enables silent-overflow detection; silent truncation without
 * a length stop remains undetectable because the original token count is unknown.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  // A refusal explanation can mention overflow without authorizing compact-and-retry.
  if (isProviderRefusalAssistantError(message)) {
    return false;
  }
  if (message.stopReason === "error" && message.errorMessage) {
    const errorMessage = message.errorMessage;
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
    if (!isNonOverflow && matchesContextOverflowMessage(errorMessage, "assistant-error")) {
      return true;
    }
  }

  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens > contextWindow) {
      return true;
    }
  }

  // Xiaomi truncates to the context window and reports length with no output.
  if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}
