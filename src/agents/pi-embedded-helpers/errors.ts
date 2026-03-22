import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  parseApiErrorPayload,
} from "../../shared/assistant-error-format.js";
export {
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox/runtime-status.js";
import { stableStringify } from "../stable-stringify.js";
import {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  matchesFormatErrorPattern,
} from "./failover-matches.js";
import type { FailoverReason } from "./types.js";

export {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

const log = createSubsystemLogger("errors");

export function formatBillingErrorMessage(provider?: string, model?: string): string {
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  if (providerLabel) {
    return `⚠️ ${providerLabel} returned a billing error — your API key has run out of credits or has an insufficient balance. Check your ${providerName} billing dashboard and top up or switch to a different API key.`;
  }
  return "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.";
}

export const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();

const RATE_LIMIT_ERROR_USER_MESSAGE = "⚠️ API rate limit reached. Please try again later.";
const OVERLOADED_ERROR_USER_MESSAGE =
  "The AI service is temporarily overloaded. Please try again in a moment.";

function formatRateLimitOrOverloadedErrorCopy(raw: string): string | undefined {
  if (isRateLimitErrorMessage(raw)) {
    return RATE_LIMIT_ERROR_USER_MESSAGE;
  }
  if (isOverloadedErrorMessage(raw)) {
    return OVERLOADED_ERROR_USER_MESSAGE;
  }
  return undefined;
}

function formatTransportErrorCopy(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();

  if (
    /\beconnrefused\b/i.test(raw) ||
    lower.includes("connection refused") ||
    lower.includes("actively refused")
  ) {
    return "LLM request failed: connection refused by the provider endpoint.";
  }

  if (
    /\beconnreset\b|\beconnaborted\b|\benetreset\b|\bepipe\b/i.test(raw) ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset") ||
    lower.includes("connection aborted")
  ) {
    return "LLM request failed: network connection was interrupted.";
  }

  if (
    /\benotfound\b|\beai_again\b/i.test(raw) ||
    lower.includes("getaddrinfo") ||
    lower.includes("no such host") ||
    lower.includes("dns")
  ) {
    return "LLM request failed: DNS lookup for the provider endpoint failed.";
  }

  if (
    /\benetunreach\b|\behostunreach\b|\behostdown\b/i.test(raw) ||
    lower.includes("network is unreachable") ||
    lower.includes("host is unreachable")
  ) {
    return "LLM request failed: the provider endpoint is unreachable from this host.";
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("connection error") ||
    lower.includes("network request failed")
  ) {
    return "LLM request failed: network connection error.";
  }

  return undefined;
}

function isReasoningConstraintErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  return (
    lower.includes("reasoning is mandatory") ||
    lower.includes("reasoning is required") ||
    lower.includes("requires reasoning") ||
    (lower.includes("reasoning") && lower.includes("cannot be disabled"))
  );
}

function hasRateLimitTpmHint(raw: string): boolean {
  const lower = raw.toLowerCase();
  return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = errorMessage.toLowerCase();

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
    // Anthropic API and OpenAI-compatible providers (e.g. ZhipuAI/GLM) return this stop reason
    // when the context window is exceeded. pi-ai surfaces it as "Unhandled stop reason: model_context_window_exceeded".
    lower.includes("context_window_exceeded") ||
    // Chinese proxy error messages for context overflow
    errorMessage.includes("上下文过长") ||
    errorMessage.includes("上下文超出") ||
    errorMessage.includes("上下文长度超") ||
    errorMessage.includes("超出最大上下文") ||
    errorMessage.includes("请压缩上下文")
  );
}

const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE =
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i;

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  // Billing/quota errors can contain patterns like "request size exceeds" or
  // "maximum token limit exceeded" that match the context overflow heuristic.
  // Billing is a more specific error class — exclude it early.
  if (isBillingErrorMessage(errorMessage)) {
    return false;
  }

  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) {
    return false;
  }
  // Rate limit errors can match the broad CONTEXT_OVERFLOW_HINT_RE pattern
  // (e.g., "request reached organization TPD rate limit" matches request.*limit).
  // Exclude them before checking context overflow heuristics.
  if (isRateLimitErrorMessage(errorMessage)) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return true;
  }
  if (RATE_LIMIT_HINT_RE.test(errorMessage)) {
    return false;
  }
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}

export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = errorMessage.toLowerCase();
  const hasCompactionTerm =
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction");
  if (!hasCompactionTerm) {
    return false;
  }
  // Treat any likely overflow shape as a compaction failure when compaction terms are present.
  // Providers often vary wording (e.g. "context window exceeded") across APIs.
  if (isLikelyContextOverflowError(errorMessage)) {
    return true;
  }
  // Keep explicit fallback for bare "context overflow" strings.
  return lower.includes("context overflow");
}

const OBSERVED_OVERFLOW_TOKEN_PATTERNS = [
  /prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i,
  /requested\s+([\d,]+)\s+tokens/i,
  /resulted in\s+([\d,]+)\s+tokens/i,
];

export function extractObservedOverflowTokenCount(errorMessage?: string): number | undefined {
  if (!errorMessage) {
    return undefined;
  }

  for (const pattern of OBSERVED_OVERFLOW_TOKEN_PATTERNS) {
    const match = errorMessage.match(pattern);
    const rawCount = match?.[1]?.replaceAll(",", "");
    if (!rawCount) {
      continue;
    }
    const parsed = Number(rawCount);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;
const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const TRANSIENT_HTTP_ERROR_CODES = new Set([499, 500, 502, 503, 504, 521, 522, 523, 524, 529]);
const HTTP_ERROR_HINTS = [
  "error",
  "bad request",
  "not found",
  "unauthorized",
  "forbidden",
  "internal server",
  "service unavailable",
  "gateway",
  "rate limit",
  "overloaded",
  "timeout",
  "timed out",
  "invalid",
  "too many requests",
  "permission",
];

type PaymentRequiredFailoverReason = Extract<FailoverReason, "billing" | "rate_limit">;

const BILLING_402_HINTS = [
  "insufficient credits",
  "insufficient quota",
  "credit balance",
  "insufficient balance",
  "plans & billing",
  "add more credits",
  "top up",
] as const;
const BILLING_402_PLAN_HINTS = [
  "upgrade your plan",
  "upgrade plan",
  "current plan",
  "subscription",
] as const;

const PERIODIC_402_HINTS = ["daily", "weekly", "monthly"] as const;
const RETRYABLE_402_RETRY_HINTS = ["try again", "retry", "temporary", "cooldown"] as const;
const RETRYABLE_402_LIMIT_HINTS = ["usage limit", "rate limit", "organization usage"] as const;
const RETRYABLE_402_SCOPED_HINTS = ["organization", "workspace"] as const;
const RETRYABLE_402_SCOPED_RESULT_HINTS = [
  "billing period",
  "exceeded",
  "reached",
  "exhausted",
] as const;
const RAW_402_MARKER_RE =
  /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment required\b|^\s*402\s+.*used up your points\b/i;
const LEADING_402_WRAPPER_RE =
  /^(?:error[:\s-]+)?(?:(?:http\s*)?402(?:\s+payment required)?|payment required)(?:[:\s-]+|$)/i;

function includesAnyHint(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function hasExplicit402BillingSignal(text: string): boolean {
  return (
    includesAnyHint(text, BILLING_402_HINTS) ||
    (includesAnyHint(text, BILLING_402_PLAN_HINTS) && text.includes("limit")) ||
    text.includes("billing hard limit") ||
    text.includes("hard limit reached") ||
    (text.includes("maximum allowed") && text.includes("limit"))
  );
}

function hasQuotaRefreshWindowSignal(text: string): boolean {
  return (
    text.includes("subscription quota limit") &&
    (text.includes("automatic quota refresh") || text.includes("rolling time window"))
  );
}

function hasRetryable402TransientSignal(text: string): boolean {
  const hasPeriodicHint = includesAnyHint(text, PERIODIC_402_HINTS);
  const hasSpendLimit = text.includes("spend limit") || text.includes("spending limit");
  const hasScopedHint = includesAnyHint(text, RETRYABLE_402_SCOPED_HINTS);
  return (
    (includesAnyHint(text, RETRYABLE_402_RETRY_HINTS) &&
      includesAnyHint(text, RETRYABLE_402_LIMIT_HINTS)) ||
    (hasPeriodicHint && (text.includes("usage limit") || hasSpendLimit)) ||
    (hasPeriodicHint && text.includes("limit") && text.includes("reset")) ||
    (hasScopedHint &&
      text.includes("limit") &&
      (hasSpendLimit || includesAnyHint(text, RETRYABLE_402_SCOPED_RESULT_HINTS)))
  );
}

function normalize402Message(raw: string): string {
  return raw.trim().toLowerCase().replace(LEADING_402_WRAPPER_RE, "").trim();
}

function classify402Message(message: string): PaymentRequiredFailoverReason {
  const normalized = normalize402Message(message);
  if (!normalized) {
    return "billing";
  }

  if (hasQuotaRefreshWindowSignal(normalized)) {
    return "rate_limit";
  }

  if (hasExplicit402BillingSignal(normalized)) {
    return "billing";
  }

  if (isRateLimitErrorMessage(normalized)) {
    return "rate_limit";
  }

  if (hasRetryable402TransientSignal(normalized)) {
    return "rate_limit";
  }

  return "billing";
}

function classifyFailoverReasonFrom402Text(raw: string): PaymentRequiredFailoverReason | null {
  if (!RAW_402_MARKER_RE.test(raw)) {
    return null;
  }
  return classify402Message(raw);
}

export function isTransientHttpError(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const status = extractLeadingHttpStatus(trimmed);
  if (!status) {
    return false;
  }
  return TRANSIENT_HTTP_ERROR_CODES.has(status.code);
}

export function classifyFailoverReasonFromHttpStatus(
  status: number | undefined,
  message?: string,
): FailoverReason | null {
  if (typeof status !== "number" || !Number.isFinite(status)) {
    return null;
  }

  if (status === 402) {
    return message ? classify402Message(message) : "billing";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 401 || status === 403) {
    if (message && isAuthPermanentErrorMessage(message)) {
      return "auth_permanent";
    }
    return "auth";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 500) {
    // Some providers (e.g. MiniMax) return billing/balance errors under HTTP 500;
    // check the message before falling through to default handling.
    if (message && isBillingErrorMessage(message)) {
      return "billing";
    }
    if (message && isOverloadedErrorMessage(message)) {
      return "overloaded";
    }
    return "timeout";
  }
  if (status === 503) {
    if (message && isOverloadedErrorMessage(message)) {
      return "overloaded";
    }
    return "timeout";
  }
  if (status === 499) {
    if (message && isOverloadedErrorMessage(message)) {
      return "overloaded";
    }
    return "timeout";
  }
  if (status === 502 || status === 504) {
    return "timeout";
  }
  if (status === 529) {
    return "overloaded";
  }
  if (status === 400 || status === 422) {
    // Some providers return quota/balance errors under HTTP 400, so do not
    // let the generic format fallback mask an explicit billing signal.
    if (message && isBillingErrorMessage(message)) {
      return "billing";
    }
    return "format";
  }
  return null;
}

function stripFinalTagsFromText(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(FINAL_TAG_RE, "");
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) {
    return text;
  }

  const normalizeBlock = (value: string) => value.trim().replace(/\s+/g, " ");
  const result: string[] = [];
  let lastNormalized: string | null = null;

  for (const block of blocks) {
    const normalized = normalizeBlock(block);
    if (lastNormalized && normalized === lastNormalized) {
      continue;
    }
    result.push(block.trim());
    lastNormalized = normalized;
  }

  if (result.length === blocks.length) {
    return text;
  }
  return result.join("\n\n");
}

function isLikelyHttpErrorText(raw: string): boolean {
  if (isCloudflareOrHtmlErrorPage(raw)) {
    return true;
  }
  const status = extractLeadingHttpStatus(raw);
  if (!status) {
    return false;
  }
  if (status.code < 400) {
    return false;
  }
  const message = status.rest.toLowerCase();
  return HTTP_ERROR_HINTS.some((hint) => message.includes(hint));
}

function shouldRewriteContextOverflowText(raw: string): boolean {
  if (!isContextOverflowError(raw)) {
    return false;
  }
  return (
    isRawApiErrorPayload(raw) ||
    isLikelyHttpErrorText(raw) ||
    ERROR_PREFIX_RE.test(raw) ||
    CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(raw)
  );
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const payload = parseApiErrorPayload(raw);
  if (!payload) {
    return null;
  }
  return stableStringify(payload);
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: { cfg?: OpenClawConfig; sessionKey?: string; provider?: string; model?: string },
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) {
    return undefined;
  }
  if (!raw) {
    return "LLM request failed with an unknown error.";
  }

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) {
      return rewritten;
    }
  }

  if (isContextOverflowError(raw)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try /reset (or /new) to start a fresh session, or use a larger-context model."
    );
  }

  if (isReasoningConstraintErrorMessage(raw)) {
    return (
      "Reasoning is required for this model endpoint. " +
      "Use /think minimal (or any non-off level) and try again."
    );
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (isMissingToolCallInputError(raw)) {
    return (
      "Session history looks corrupted (tool call input missing). " +
      "Use /new to start a fresh session. " +
      "If this keeps happening, reset the session or delete the corrupted session transcript."
    );
  }

  const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  const transientCopy = formatRateLimitOrOverloadedErrorCopy(raw);
  if (transientCopy) {
    return transientCopy;
  }

  const transportCopy = formatTransportErrorCopy(raw);
  if (transportCopy) {
    return transportCopy;
  }

  if (isTimeoutErrorMessage(raw)) {
    return "LLM request timed out.";
  }

  if (isBillingErrorMessage(raw)) {
    return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model);
  }

  if (isLikelyHttpErrorText(raw) || isRawApiErrorPayload(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  // Never return raw unhandled errors - log for debugging but return safe message
  if (raw.length > 600) {
    log.warn(`Long error truncated: ${raw.slice(0, 200)}`);
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function sanitizeUserFacingText(text: string, opts?: { errorContext?: boolean }): string {
  if (!text) {
    return text;
  }
  const errorContext = opts?.errorContext ?? false;
  const stripped = stripFinalTagsFromText(text);
  const trimmed = stripped.trim();
  if (!trimmed) {
    return "";
  }

  // Only apply error-pattern rewrites when the caller knows this text is an error payload.
  // Otherwise we risk swallowing legitimate assistant text that merely *mentions* these errors.
  if (errorContext) {
    if (/incorrect role information|roles must alternate/i.test(trimmed)) {
      return (
        "Message ordering conflict - please try again. " +
        "If this persists, use /new to start a fresh session."
      );
    }

    if (shouldRewriteContextOverflowText(trimmed)) {
      return (
        "Context overflow: prompt too large for the model. " +
        "Try /reset (or /new) to start a fresh session, or use a larger-context model."
      );
    }

    if (isBillingErrorMessage(trimmed)) {
      return BILLING_ERROR_USER_MESSAGE;
    }

    if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }

    if (ERROR_PREFIX_RE.test(trimmed)) {
      const prefixedCopy = formatRateLimitOrOverloadedErrorCopy(trimmed);
      if (prefixedCopy) {
        return prefixedCopy;
      }
      const transportCopy = formatTransportErrorCopy(trimmed);
      if (transportCopy) {
        return transportCopy;
      }
      if (isTimeoutErrorMessage(trimmed)) {
        return "LLM request timed out.";
      }
      return formatRawAssistantErrorForUi(trimmed);
    }
  }

  // Strip leading blank lines (including whitespace-only lines) without clobbering indentation on
  // the first content line (e.g. markdown/code blocks).
  const withoutLeadingEmptyLines = stripped.replace(/^(?:[ \t]*\r?\n)+/, "");
  return collapseConsecutiveDuplicateBlocks(withoutLeadingEmptyLines);
}

export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}

const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;

const IMAGE_DIMENSION_ERROR_RE =
  /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;

export function isMissingToolCallInputError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  return TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw);
}

export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isBillingErrorMessage(msg.errorMessage ?? "");
}

function isJsonApiInternalServerError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const value = raw.toLowerCase();
  // Anthropic often wraps transient 500s in JSON payloads like:
  // {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
  return value.includes('"type":"api_error"') && value.includes("internal server error");
}

export function parseImageDimensionError(raw: string): {
  maxDimensionPx?: number;
  messageIndex?: number;
  contentIndex?: number;
  raw: string;
} | null {
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (!lower.includes("image dimensions exceed max allowed size")) {
    return null;
  }
  const limitMatch = raw.match(IMAGE_DIMENSION_ERROR_RE);
  const pathMatch = raw.match(IMAGE_DIMENSION_PATH_RE);
  return {
    maxDimensionPx: limitMatch?.[1] ? Number.parseInt(limitMatch[1], 10) : undefined,
    messageIndex: pathMatch?.[1] ? Number.parseInt(pathMatch[1], 10) : undefined,
    contentIndex: pathMatch?.[2] ? Number.parseInt(pathMatch[2], 10) : undefined,
    raw,
  };
}

export function isImageDimensionErrorMessage(raw: string): boolean {
  return Boolean(parseImageDimensionError(raw));
}

export function parseImageSizeError(raw: string): {
  maxMb?: number;
  raw: string;
} | null {
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (!lower.includes("image exceeds") || !lower.includes("mb")) {
    return null;
  }
  const match = raw.match(IMAGE_SIZE_ERROR_RE);
  return {
    maxMb: match?.[1] ? Number.parseFloat(match[1]) : undefined,
    raw,
  };
}

export function isImageSizeError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  return Boolean(parseImageSizeError(errorMessage));
}

export function isCloudCodeAssistFormatError(raw: string): boolean {
  return !isImageDimensionErrorMessage(raw) && matchesFormatErrorPattern(raw);
}

export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

export function isModelNotFoundErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();

  // Direct pattern matches from OpenClaw internals and common providers.
  if (
    lower.includes("unknown model") ||
    lower.includes("model not found") ||
    lower.includes("model_not_found") ||
    lower.includes("not_found_error") ||
    (lower.includes("does not exist") && lower.includes("model")) ||
    (lower.includes("invalid model") && !lower.includes("invalid model reference"))
  ) {
    return true;
  }

  // Google Gemini: "models/X is not found for api version"
  if (/models\/[^\s]+ is not found/i.test(raw)) {
    return true;
  }

  // JSON error payloads: {"status": "NOT_FOUND"} or {"code": 404} combined with not-found text.
  if (/\b404\b/.test(raw) && /not[-_ ]?found/i.test(raw)) {
    return true;
  }

  return false;
}

function isCliSessionExpiredErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  return (
    lower.includes("session not found") ||
    lower.includes("session does not exist") ||
    lower.includes("session expired") ||
    lower.includes("session invalid") ||
    lower.includes("conversation not found") ||
    lower.includes("conversation does not exist") ||
    lower.includes("conversation expired") ||
    lower.includes("conversation invalid") ||
    lower.includes("no such session") ||
    lower.includes("invalid session") ||
    lower.includes("session id not found") ||
    lower.includes("conversation id not found")
  );
}

export function classifyFailoverReason(raw: string): FailoverReason | null {
  if (isImageDimensionErrorMessage(raw)) {
    return null;
  }
  if (isImageSizeError(raw)) {
    return null;
  }
  if (isCliSessionExpiredErrorMessage(raw)) {
    return "session_expired";
  }
  if (isModelNotFoundErrorMessage(raw)) {
    return "model_not_found";
  }
  const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
  if (reasonFrom402Text) {
    return reasonFrom402Text;
  }
  if (isPeriodicUsageLimitErrorMessage(raw)) {
    return isBillingErrorMessage(raw) ? "billing" : "rate_limit";
  }
  if (isRateLimitErrorMessage(raw)) {
    return "rate_limit";
  }
  if (isOverloadedErrorMessage(raw)) {
    return "overloaded";
  }
  if (isTransientHttpError(raw)) {
    // 529 is always overloaded, even without explicit overload keywords in the body.
    const status = extractLeadingHttpStatus(raw.trim());
    if (status?.code === 529) {
      return "overloaded";
    }
    // Some providers (e.g. MiniMax) return billing/balance errors under HTTP 500;
    // do not let the transient-5xx fallback mask an explicit billing signal.
    if (isBillingErrorMessage(raw)) {
      return "billing";
    }
    // Treat remaining transient 5xx provider failures as retryable transport issues.
    return "timeout";
  }
  if (isJsonApiInternalServerError(raw)) {
    return "timeout";
  }
  if (isCloudCodeAssistFormatError(raw)) {
    return "format";
  }
  if (isBillingErrorMessage(raw)) {
    return "billing";
  }
  if (isTimeoutErrorMessage(raw)) {
    return "timeout";
  }
  if (isAuthPermanentErrorMessage(raw)) {
    return "auth_permanent";
  }
  if (isAuthErrorMessage(raw)) {
    return "auth";
  }
  return null;
}

export function isFailoverErrorMessage(raw: string): boolean {
  return classifyFailoverReason(raw) !== null;
}

export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isFailoverErrorMessage(msg.errorMessage ?? "");
}
