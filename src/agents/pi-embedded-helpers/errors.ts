import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox.js";
import { stableStringify } from "../stable-stringify.js";
import type { FailoverReason } from "./types.js";

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

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = errorMessage.toLowerCase();

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (lower.includes("tpm") || lower.includes("tokens per minute")) {
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
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
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
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b/i;

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  const lower = errorMessage.toLowerCase();
  if (lower.includes("tpm") || lower.includes("tokens per minute")) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
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

const ERROR_PAYLOAD_PREFIX_RE =
  /^(?:error|api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error)[:\s-]+/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;
const ERROR_PREFIX_RE =
  /^(?:error|api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|request failed|failed|exception)[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const BILLING_ERROR_HEAD_RE =
  /^(?:error[:\s-]+)?billing(?:\s+error)?(?:[:\s-]+|$)|^(?:error[:\s-]+)?(?:credit balance|insufficient credits?|payment required|http\s*402\b)/i;
const BILLING_ERROR_HARD_402_RE =
  /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|^\s*402\s+payment/i;
const HTTP_STATUS_PREFIX_RE = /^(?:http\s*)?(\d{3})\s+(.+)$/i;
const HTTP_STATUS_CODE_PREFIX_RE = /^(?:http\s*)?(\d{3})(?:\s+([\s\S]+))?$/i;
const HTML_ERROR_PREFIX_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const CLOUDFLARE_HTML_ERROR_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
const TRANSIENT_HTTP_ERROR_CODES = new Set([500, 502, 503, 504, 521, 522, 523, 524, 529]);
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

function extractLeadingHttpStatus(raw: string): { code: number; rest: string } | null {
  const match = raw.match(HTTP_STATUS_CODE_PREFIX_RE);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  if (!Number.isFinite(code)) {
    return null;
  }
  return { code, rest: (match[2] ?? "").trim() };
}

export function isCloudflareOrHtmlErrorPage(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  const status = extractLeadingHttpStatus(trimmed);
  if (!status || status.code < 500) {
    return false;
  }

  if (CLOUDFLARE_HTML_ERROR_CODES.has(status.code)) {
    return true;
  }

  return (
    status.code < 600 && HTML_ERROR_PREFIX_RE.test(status.rest) && /<\/html>/i.test(status.rest)
  );
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
  const match = raw.match(HTTP_STATUS_PREFIX_RE);
  if (!match) {
    return false;
  }
  const code = Number(match[1]);
  if (!Number.isFinite(code) || code < 400) {
    return false;
  }
  const message = match[2].toLowerCase();
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

type ErrorPayload = Record<string, unknown>;

function isErrorPayloadObject(payload: unknown): payload is ErrorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as ErrorPayload;
  if (record.type === "error") {
    return true;
  }
  if (typeof record.request_id === "string" || typeof record.requestId === "string") {
    return true;
  }
  if ("error" in record) {
    const err = record.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const errRecord = err as ErrorPayload;
      if (
        typeof errRecord.message === "string" ||
        typeof errRecord.type === "string" ||
        typeof errRecord.code === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseApiErrorPayload(raw: string): ErrorPayload | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const candidates = [trimmed];
  if (ERROR_PAYLOAD_PREFIX_RE.test(trimmed)) {
    candidates.push(trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim());
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isErrorPayloadObject(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse errors
    }
  }
  return null;
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

export type ApiErrorInfo = {
  httpCode?: string;
  type?: string;
  message?: string;
  requestId?: string;
};

export function parseApiErrorInfo(raw?: string): ApiErrorInfo | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let httpCode: string | undefined;
  let candidate = trimmed;

  const httpPrefixMatch = candidate.match(/^(\d{3})\s+(.+)$/s);
  if (httpPrefixMatch) {
    httpCode = httpPrefixMatch[1];
    candidate = httpPrefixMatch[2].trim();
  }

  const payload = parseApiErrorPayload(candidate);
  if (!payload) {
    return null;
  }

  const requestId =
    typeof payload.request_id === "string"
      ? payload.request_id
      : typeof payload.requestId === "string"
        ? payload.requestId
        : undefined;

  const topType = typeof payload.type === "string" ? payload.type : undefined;
  const topMessage = typeof payload.message === "string" ? payload.message : undefined;

  let errType: string | undefined;
  let errMessage: string | undefined;
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    const err = payload.error as Record<string, unknown>;
    if (typeof err.type === "string") {
      errType = err.type;
    }
    if (typeof err.code === "string" && !errType) {
      errType = err.code;
    }
    if (typeof err.message === "string") {
      errMessage = err.message;
    }
  }

  return {
    httpCode,
    type: errType ?? topType,
    message: errMessage ?? topMessage,
    requestId,
  };
}

export function formatRawAssistantErrorForUi(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "LLM request failed with an unknown error.";
  }

  const leadingStatus = extractLeadingHttpStatus(trimmed);
  if (leadingStatus && isCloudflareOrHtmlErrorPage(trimmed)) {
    return `The AI service is temporarily unavailable (HTTP ${leadingStatus.code}). Please try again in a moment.`;
  }

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    const rest = httpMatch[2].trim();
    if (!rest.startsWith("{")) {
      return `HTTP ${httpMatch[1]}: ${rest}`;
    }
  }

  const info = parseApiErrorInfo(trimmed);
  if (info?.message) {
    const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
    const type = info.type ? ` ${info.type}` : "";
    const requestId = info.requestId ? ` (request_id: ${info.requestId})` : "";
    return `${prefix}${type}: ${info.message}${requestId}`;
  }

  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
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

type ErrorPattern = RegExp | string;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "model_cooldown",
    "cooling down",
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "usage limit",
    "tpm",
    "tokens per minute",
  ],
  overloaded: [
    /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
    "overloaded",
    "service unavailable",
    "high demand",
  ],
  timeout: [
    "timeout",
    "timed out",
    "deadline exceeded",
    "context deadline exceeded",
    /without sending (?:any )?chunks?/i,
    /\bstop reason:\s*abort\b/i,
    /\breason:\s*abort\b/i,
    /\bunhandled stop reason:\s*abort\b/i,
  ],
  billing: [
    /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment/i,
    "payment required",
    "insufficient credits",
    "credit balance",
    "plans & billing",
    "insufficient balance",
  ],
  authPermanent: [
    /api[_ ]?key[_ ]?(?:revoked|invalid|deactivated|deleted)/i,
    "invalid_api_key",
    "key has been disabled",
    "key has been revoked",
    "account has been deactivated",
    /could not (?:authenticate|validate).*(?:api[_ ]?key|credentials)/i,
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/,
    "incorrect api key",
    "invalid token",
    "authentication",
    "re-authenticate",
    "oauth token refresh failed",
    "unauthorized",
    "forbidden",
    "access denied",
    "insufficient permissions",
    "insufficient permission",
    /missing scopes?:/i,
    "expired",
    "token has expired",
    /\b401\b/,
    /\b403\b/,
    "no credentials found",
    "no api key found",
  ],
  format: [
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
    /tool call id was.*must be/i,
  ],
} as const;

const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;

const IMAGE_DIMENSION_ERROR_RE =
  /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;

function matchesErrorPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  if (!raw) {
    return false;
  }
  const value = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

/**
 * Maximum character length for a string to be considered a billing error message.
 * Real API billing errors are short, structured messages (typically under 300 chars).
 * Longer text is almost certainly assistant content that happens to mention billing keywords.
 */
const BILLING_ERROR_MAX_LENGTH = 512;

export function isBillingErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) {
    return false;
  }
  // Real billing error messages from APIs are short structured payloads.
  // Long text (e.g. multi-paragraph assistant responses) that happens to mention
  // "billing", "payment", etc. should not be treated as a billing error.
  if (raw.length > BILLING_ERROR_MAX_LENGTH) {
    // Keep explicit status/code 402 detection for providers that wrap errors in
    // larger payloads (for example nested JSON bodies or prefixed metadata).
    return BILLING_ERROR_HARD_402_RE.test(value);
  }
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) {
    return true;
  }
  if (!BILLING_ERROR_HEAD_RE.test(raw)) {
    return false;
  }
  return (
    value.includes("upgrade") ||
    value.includes("credits") ||
    value.includes("payment") ||
    value.includes("plan")
  );
}

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

export function isAuthPermanentErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.authPermanent);
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}

export function isOverloadedErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
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
  return !isImageDimensionErrorMessage(raw) && matchesErrorPatterns(raw, ERROR_PATTERNS.format);
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

export function classifyFailoverReason(raw: string): FailoverReason | null {
  if (isImageDimensionErrorMessage(raw)) {
    return null;
  }
  if (isImageSizeError(raw)) {
    return null;
  }
  if (isModelNotFoundErrorMessage(raw)) {
    return "model_not_found";
  }
  if (isTransientHttpError(raw)) {
    // Treat transient 5xx provider failures as retryable transport issues.
    return "timeout";
  }
  if (isJsonApiInternalServerError(raw)) {
    return "timeout";
  }
  if (isRateLimitErrorMessage(raw)) {
    return "rate_limit";
  }
  if (isOverloadedErrorMessage(raw)) {
    return "rate_limit";
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
