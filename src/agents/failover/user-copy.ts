import { stableStringify } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCommandErrorForUser } from "../../process/command-error.js";
import {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  formatTransportErrorCopy,
  isCloudflareOrHtmlErrorPage,
  isGenericProviderInternalError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseApiErrorInfo,
  parseApiErrorPayload,
} from "../../shared/assistant-error-format.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import type { CliTimeoutContext, FallbackAttemptRecord } from "../failover-error.js";
import { ERROR_DETAILS_HINT, ERROR_PREFIX_RE } from "./assistant-request-failure-copy.js";
import { classifyFailoverReasonCore } from "./classify-core.js";
import {
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  splitFailoverAggregateLegs,
} from "./message-patterns.js";
import {
  classifyProviderRequestFacets,
  type ProviderRequestFacet,
} from "./request-error-facets.js";
import type { FailoverClassification, FailoverReason } from "./signal.js";

const RATE_LIMIT_ERROR_USER_MESSAGE =
  "⚠️ The AI service needs a short break. Please try again in a few minutes.";
export const AUTH_INVALID_TOKEN_USER_TEXT =
  "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.";
const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT =
  "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.";
export const renderFailoverCodeUserCopy = (code: unknown): string | undefined =>
  code === "selected_auth_profile_unavailable"
    ? SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT
    : undefined;
const MODEL_CAPACITY_ERROR_USER_MESSAGE =
  "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
const OVERLOADED_ERROR_USER_MESSAGE =
  "The AI service is temporarily overloaded. Please try again in a moment.";
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\bresets?\b|\bplan\b|\bquota\b/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context (?:length|window) exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const PROVIDER_PROMPT_SIZE_LIMIT_RE =
  /\b(?:this\s+)?prompt\s+(?:is\s+)?(?:too long|longer than)\b.{0,120}\b(?:free tier|single request|per[- ]request)\b/i;
const PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE =
  "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.";
const PROVIDER_PROMPT_SIZE_ERROR_PARSE_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;

/** Format billing copy with optional provider/model and credential context. */
export function formatBillingErrorMessage(
  provider?: string,
  model?: string,
  authMode?: string,
): string {
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  const isSubscriptionAuth = authMode === "oauth" || authMode === "token";
  if (isSubscriptionAuth) {
    return `⚠️ ${providerLabel ?? "API provider"} returned a billing error — check your account for subscription or usage limits, then try again.`;
  }
  return providerLabel
    ? `⚠️ ${providerLabel} returned a billing error — check your account's balance and usage limits before trying again.`
    : "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.";
}

const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();

function extractProviderRateLimitMessage(raw: string): string | undefined {
  const withoutPrefix = raw.replace(ERROR_PREFIX_RE, "").trim();
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(withoutPrefix);
  const candidate =
    info?.message ?? (extractLeadingHttpStatus(withoutPrefix)?.rest || withoutPrefix);
  if (!candidate || !RATE_LIMIT_SPECIFIC_HINT_RE.test(candidate)) {
    return undefined;
  }
  if (isCloudflareOrHtmlErrorPage(withoutPrefix)) {
    return undefined;
  }
  const trimmed = candidate.trim().replace(/\s+\((?:rate_limit|overloaded|unknown)\)$/iu, "");
  if (
    trimmed.length > 300 ||
    trimmed.startsWith("{") ||
    /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)
  ) {
    return undefined;
  }
  return `⚠️ ${trimmed}`;
}

function renderProviderPromptSizeLimitCopy(raw: string): string | undefined {
  if (raw.length > PROVIDER_PROMPT_SIZE_ERROR_PARSE_MAX_LENGTH) {
    return undefined;
  }
  const status = extractErrorHttpStatus(raw);
  if (status?.code !== 400) {
    return undefined;
  }
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(status.rest);
  const providerMessage = info?.message ?? status.rest;
  return providerMessage.length <= 300 && PROVIDER_PROMPT_SIZE_LIMIT_RE.test(providerMessage)
    ? PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE
    : undefined;
}

/** Render rate-limit versus overload copy from the canonical classified reason. */
export function renderRateLimitOrOverloadedCopy(params: {
  reason: Extract<FailoverReason, "rate_limit" | "overloaded">;
  raw?: string;
}): string {
  const raw = params.raw ?? "";
  if (MODEL_CAPACITY_ERROR_RE.test(raw)) {
    return MODEL_CAPACITY_ERROR_USER_MESSAGE;
  }
  if (params.reason === "overloaded") {
    return OVERLOADED_ERROR_USER_MESSAGE;
  }
  const promptSizeCopy = renderProviderPromptSizeLimitCopy(raw);
  if (promptSizeCopy) {
    return promptSizeCopy;
  }
  for (const leg of splitFailoverAggregateLegs(raw)) {
    const fromLeg = extractProviderRateLimitMessage(leg);
    if (fromLeg) {
      return fromLeg;
    }
  }
  return extractProviderRateLimitMessage(raw) ?? RATE_LIMIT_ERROR_USER_MESSAGE;
}

export function formatDiskSpaceErrorCopy(raw: string): string | undefined {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\benospc\b/i.test(raw) ||
    lower.includes("no space left on device") ||
    lower.includes("disk full")
    ? "OpenClaw could not write local session data because the disk is full. Free some disk space and try again."
    : undefined;
}

export function isInvalidStreamingEventOrderError(raw: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("unexpected event order") &&
    lower.includes("message_start") &&
    lower.includes("message_stop")
  );
}

export function isStreamingJsonParseError(raw: string): boolean {
  return raw.trim() === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE;
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const payload = parseApiErrorPayload(raw);
  return payload ? stableStringify(payload) : null;
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

/** Recognize provider HTTP/HTML failures from canonical classification facts. */
export function isLikelyHttpErrorText(raw: string): boolean {
  if (isCloudflareOrHtmlErrorPage(raw)) {
    return true;
  }
  const status = extractLeadingHttpStatus(raw);
  return Boolean(
    status &&
    status.code >= 400 &&
    (classifyFailoverReasonCore(raw) !== null ||
      classifyProviderRequestFacets({ status: status.code, message: raw }) !== null),
  );
}

function shouldRewriteRawPayloadWithoutErrorContext(raw: string): boolean {
  if (
    raw.length > NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH ||
    !NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE.test(raw)
  ) {
    return false;
  }
  const info = parseApiErrorInfo(raw);
  const normalizedType = normalizeLowercaseStringOrEmpty(info?.type);
  if (normalizedType.endsWith("_error")) {
    return true;
  }
  const code = Number(info?.httpCode);
  return Number.isFinite(code) && code >= 400;
}

/** Sanitize presentation text, then render error copy from classified facts when requested. */
export function renderSanitizedUserFacingText(
  sanitized: string,
  opts?: { errorContext?: boolean },
): string {
  if (!sanitized) {
    return sanitized;
  }
  const trimmed = sanitized.trim();
  if (!opts?.errorContext) {
    return shouldRewriteRawPayloadWithoutErrorContext(trimmed)
      ? formatRawAssistantErrorForUi(trimmed)
      : sanitized;
  }
  for (const format of [
    formatCommandErrorForUser,
    formatExecDeniedUserMessage,
    formatDiskSpaceErrorCopy,
  ]) {
    const copy = format(trimmed);
    if (copy) {
      return copy;
    }
  }
  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
  }
  const reason = classifyFailoverReasonCore(trimmed);
  const status = extractLeadingHttpStatus(trimmed);
  const rawPayload = isRawApiErrorPayload(trimmed);
  if (
    reason === "context_overflow" &&
    (rawPayload ||
      (status && status.code >= 400) ||
      ERROR_PREFIX_RE.test(trimmed) ||
      CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(trimmed))
  ) {
    return CONTEXT_OVERFLOW_ERROR_MESSAGE;
  }
  if (reason === "billing" || reason === "rate_limit" || reason === "overloaded") {
    return reason === "billing"
      ? BILLING_ERROR_USER_MESSAGE
      : renderRateLimitOrOverloadedCopy({ reason, raw: trimmed });
  }
  // Labeled HTTP statuses require the full grammar; keep provider retry detail above.
  const providerRequestCode = resolveProviderRequestFailureCode({
    classification: reason ? { kind: "reason", reason } : null,
    facet: null,
    status: extractErrorHttpStatus(trimmed)?.code,
  });
  if (providerRequestCode) {
    return PROVIDER_REQUEST_COPY[providerRequestCode];
  }
  if (isGenericProviderInternalError(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isInvalidStreamingEventOrderError(trimmed)) {
    return "LLM request failed: provider returned an invalid streaming response. Please try again.";
  }
  if (rawPayload || (status && status.code >= 400 && reason)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isStreamingJsonParseError(trimmed)) {
    return "LLM streaming response contained a malformed fragment. Please try again.";
  }
  if (ERROR_PREFIX_RE.test(trimmed)) {
    const transport = formatTransportErrorCopy(trimmed);
    if (transport) {
      return transport;
    }
    if (isProviderCompletedErrorFinishReasonMessage(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (reason === "timeout") {
      return "LLM request timed out.";
    }
    return formatRawAssistantErrorForUi(trimmed);
  }
  return sanitized;
}

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.";
export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE =
  "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";
const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The AI service can't accept more requests right now. Wait a few minutes, then try again. If it continues, check your account's usage and billing limits.";
const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";
const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
const PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE =
  "⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`.";

const PROVIDER_REQUEST_COPY = {
  provider_authentication_error: PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  provider_conversation_state_error: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  provider_internal_error: PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  provider_model_unavailable: PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE,
  provider_rate_limit_or_quota_error: PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
};

type ProviderRequestErrorCode = keyof typeof PROVIDER_REQUEST_COPY;

function resolveProviderRequestFailureCode(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
}): ProviderRequestErrorCode | undefined {
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  if (reason === "auth" && params.status === 401) {
    return "provider_authentication_error";
  }
  if (reason === "model_not_found") {
    return "provider_model_unavailable";
  }
  switch (params.facet) {
    case "quota-429":
      return "provider_rate_limit_or_quota_error";
    case "conversation-state":
      return "provider_conversation_state_error";
    case "provider-internal":
    case "provider-internal-503":
      return "provider_internal_error";
    default:
      return undefined;
  }
}

export function resolveProviderRequestFailureCopy(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
  technicalMessage: string;
}) {
  const code = resolveProviderRequestFailureCode(params);
  if (!code) {
    return undefined;
  }
  return {
    code,
    userMessage: PROVIDER_REQUEST_COPY[code],
    technicalMessage: params.technicalMessage,
  };
}

export type ReplyFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

function extractCodexUsageLimitErrorMessage(
  attempts: readonly ReplyFallbackAttempt[],
  directMessage: string,
  directReason: FailoverReason | undefined,
  directProvider: string | undefined,
  sanitizeText?: (text: string) => string,
): string | undefined {
  const attempt = attempts.find(
    (candidate) =>
      candidate.provider === "openai" && candidate.reason === "rate_limit" && candidate.error,
  );
  const text =
    attempt?.error ??
    (directProvider === "openai" && directReason === "rate_limit" ? directMessage : undefined);
  if (!text) {
    return undefined;
  }
  const message = renderSanitizedUserFacingText(sanitizeText?.(text) ?? text, {
    errorContext: true,
  })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!message) {
    return undefined;
  }
  const truncated = message.length > 500 ? `${truncateUtf16Safe(message, 497)}...` : message;
  return truncated.startsWith("⚠️") ? truncated : `⚠️ ${truncated}`;
}

/** Render the reply surface's rate-limit copy, including structured cooldown context. */
export function renderRateLimitReplyCopy(params: {
  message: string;
  reason?: FailoverReason;
  provider?: string;
  attempts?: readonly ReplyFallbackAttempt[];
  cooldownExpiry?: number | null;
  nowMs?: number;
  sanitizeText?: (text: string) => string;
}): string {
  const attempts = params.attempts ?? [];
  if (params.reason === "rate_limit") {
    const promptSizeCopy = renderProviderPromptSizeLimitCopy(params.message);
    if (promptSizeCopy) {
      return promptSizeCopy;
    }
  }
  const usageLimit = extractCodexUsageLimitErrorMessage(
    attempts,
    params.message,
    params.reason,
    params.provider,
    params.sanitizeText,
  );
  if (usageLimit) {
    return usageLimit;
  }
  if (attempts.some((attempt) => attempt.reason === "billing") || params.reason === "billing") {
    return BILLING_ERROR_USER_MESSAGE;
  }
  if (attempts.length === 0) {
    if (params.reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(params.message)) {
      const providerMessage = renderSanitizedUserFacingText(
        params.sanitizeText?.(params.message) ?? params.message,
        { errorContext: true },
      );
      return providerMessage.startsWith("⚠️") ? providerMessage : `⚠️ ${providerMessage}`;
    }
    return RATE_LIMIT_ERROR_USER_MESSAGE;
  }
  for (const attempt of attempts) {
    if (attempt.reason !== "rate_limit" || !attempt.error) {
      continue;
    }
    const hint = extractProviderRateLimitMessage(attempt.error);
    if (hint) {
      return params.sanitizeText?.(attempt.error) ?? hint;
    }
  }
  const expiry = params.cooldownExpiry;
  const nowMs = params.nowMs ?? Date.now();
  if (typeof expiry === "number" && expiry > nowMs) {
    const secsLeft = Math.max(1, Math.ceil((expiry - nowMs) / 1000));
    return secsLeft <= 60
      ? `⚠️ The AI service needs a short break. Please try again in ~${secsLeft}s.`
      : `⚠️ The AI service needs a short break. Please try again in ~${Math.ceil(secsLeft / 60)} min.`;
  }
  const attemptedModels = new Set(
    attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
  );
  return attemptedModels.size > 1 &&
    attempts.every((attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded")
    ? "⚠️ The AI services are busy. Please try again in a few minutes."
    : RATE_LIMIT_ERROR_USER_MESSAGE;
}

export function renderBillingReplyCopy(params: {
  provider?: string;
  model?: string;
  authMode?: string;
  attempts?: readonly ReplyFallbackAttempt[];
}): string {
  const attempts = params.attempts ?? [];
  const billingFailure =
    attempts.length > 0
      ? attempts.find(
          (attempt) =>
            attempt.reason === "billing" &&
            (attempt.authMode === "oauth" || attempt.authMode === "token"),
        )
      : params.authMode === "oauth" || params.authMode === "token"
        ? params
        : undefined;
  return billingFailure
    ? formatBillingErrorMessage(
        billingFailure.provider,
        billingFailure.model,
        billingFailure.authMode,
      )
    : BILLING_ERROR_USER_MESSAGE;
}

export function renderMissingApiKeyReplyCopy(params?: {
  provider: string;
  providerGuidance?: boolean;
}): string | null {
  const provider = params?.provider.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && params?.providerGuidance) {
    return "⚠️ OpenAI needs a different sign-in for this model. Open Models in the Control UI or run `openclaw configure` to choose how to connect.";
  }
  return provider === "openai"
    ? "⚠️ Couldn't connect to OpenAI. Run `openclaw doctor --fix`, then try again. If it still fails, open Models in the Control UI or run `openclaw configure`."
    : "⚠️ This AI service isn't set up yet. Sign in under Models in the Control UI or run `openclaw configure`.";
}

const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE =
  /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE =
  /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;
const CODEX_SESSION_GENERATION_NOT_CURRENT_RE =
  /\bcodex session generation is no longer current\b/iu;
const CODEX_EXECUTION_NODE_DISCONNECTED_RE =
  /^Codex execution node disconnected; start a fresh attempt\. \((?:execution node (?:failed|disconnected)|execution socket (?:closed|failed))(?:: [^\r\n]{1,240})?\)(?:\r?\n|$)/u;

export function renderCodexAppServerFailureCopy(message: string): string | null {
  const normalizedMessage = message.trim();
  if (CODEX_SESSION_GENERATION_NOT_CURRENT_RE.test(normalizedMessage)) {
    return "⚠️ This Codex session changed before your message could run. Please send it again.";
  }
  if (CODEX_EXECUTION_NODE_DISCONNECTED_RE.test(normalizedMessage)) {
    return "⚠️ Codex execution node disconnected. Start a fresh attempt.";
  }
  if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) {
    return "⚠️ Lost the connection to Codex before it confirmed the task was finished. It may still be running. Check the conversation in the Control UI before trying again.";
  }
  if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) {
    return "⚠️ Codex hasn't confirmed whether the task finished. It may still be running. Check the conversation in the Control UI before trying again.";
  }
  return null;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;

export function renderCliTimeoutReplyCopy(params: {
  message: string;
  cliTimeout?: CliTimeoutContext;
  provider?: string;
  replayPrevented?: boolean;
}): string | null {
  const stall = params.message.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = params.message.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = params.cliTimeout;
  const seconds = timeout?.timeoutSeconds ?? Number((stall ?? overall)?.[1]);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  const mode = timeout?.mode ?? (stall ? "no-output" : "overall");
  const mayHaveCompletedWork =
    timeout?.observedActivity ||
    timeout?.backgroundTaskCount ||
    timeout?.activeToolCount ||
    params.replayPrevented;
  const workStatus = mayHaveCompletedWork
    ? " Some work may have completed. Check its results before trying again."
    : "";
  const summary = mode === "no-output" ? "The task stopped responding." : "The task took too long.";
  const remedy =
    mode === "no-output"
      ? "Check for a sign-in or confirmation prompt in the terminal."
      : "Try a smaller task, or increase the task time limit in the Control UI settings.";
  return `⚠️ ${summary}${workStatus} ${remedy}`;
}

type AuthProfileFailureCopyParams = {
  reason: FailoverReason;
  provider: string;
  allInCooldown: boolean;
  recoveryHint?: string;
};

const authProfileUnavailableCopy = (provider: string) =>
  `Couldn't reach ${provider} with any of your saved logins right now.`;

const AUTH_PROFILE_COOLDOWN_COPY = {
  auth: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  auth_permanent: (provider: string) => `${provider} isn't accepting your saved login anymore.`,
  format: authProfileUnavailableCopy,
  rate_limit: (provider: string) =>
    `${provider} is asking us to slow down. Please wait a moment before trying again.`,
  overloaded: (provider: string) =>
    `${provider} is overloaded right now. Please wait a moment before trying again.`,
  billing: (provider: string) =>
    `${provider} rejected the request — looks like a billing issue on the account.`,
  server_error: (provider: string) =>
    `${provider} is having issues right now. Please wait a moment before trying again.`,
  timeout: (provider: string) =>
    `${provider} hasn't been responding. Please wait a moment before trying again.`,
  tls_certificate: authProfileUnavailableCopy,
  context_overflow: authProfileUnavailableCopy,
  model_not_found: (provider: string) => `${provider} can't find the model you're using right now.`,
  session_expired: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  empty_response: authProfileUnavailableCopy,
  no_error_details: authProfileUnavailableCopy,
  unclassified: authProfileUnavailableCopy,
  unknown: authProfileUnavailableCopy,
} satisfies Record<FailoverReason, (provider: string) => string>;

const AUTH_PROFILE_DIRECT_COPY: Partial<Record<FailoverReason, (provider: string) => string>> = {
  auth: AUTH_PROFILE_COOLDOWN_COPY.auth,
  auth_permanent: (provider) => `${provider} isn't accepting your saved login.`,
  billing: AUTH_PROFILE_COOLDOWN_COPY.billing,
  session_expired: AUTH_PROFILE_COOLDOWN_COPY.session_expired,
};

const AUTH_PROFILE_RECOVERY_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "billing",
  "context_overflow",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

export function renderAuthProfileFailoverCopy(params: AuthProfileFailureCopyParams): string {
  const description = params.allInCooldown
    ? AUTH_PROFILE_COOLDOWN_COPY[params.reason](params.provider)
    : AUTH_PROFILE_DIRECT_COPY[params.reason]?.(params.provider);
  const hint = AUTH_PROFILE_RECOVERY_REASONS.has(params.reason) ? params.recoveryHint : null;
  return [description ?? authProfileUnavailableCopy(params.provider), hint]
    .filter(Boolean)
    .join(" ");
}

export function renderControlUiAgentFailureCopy(): string {
  return `⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. ${ERROR_DETAILS_HINT}`;
}
