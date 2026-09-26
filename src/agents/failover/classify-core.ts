/** Classifies prepared error facts without resolving provider runtime. */
import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { inspectTlsCertificateError } from "@openclaw/ai/internal/shared";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  extractLeadingHttpStatus,
  isGenericProviderInternalError,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { classifyOAuthRefreshFailure } from "../auth-profiles/oauth-refresh-failure.js";
import {
  isImageDimensionErrorMessage,
  isImageSizeError,
} from "../embedded-agent-helpers/image-errors.js";
import { isModelNotFoundErrorMessage } from "../live-model-errors.js";
import {
  classifyCoreFailoverReasonFromErrorType,
  classifyFailoverClassificationFromHttpStatus,
  classifyFailoverReasonFrom402Text,
  classifyFailoverReasonFromCode,
  failoverReasonFromClassification,
  inferSignalStatus,
  isClaudeCliAuthError,
  isExactUnknownNoDetailsError,
  isGenericUnknownStreamErrorMessage,
  isReplayInvalidErrorMessage,
  isUnsupportedImageInputErrorMessage,
  toPluginClassification,
  toReasonClassification,
} from "./classification-rules.js";
import {
  isContextOverflowErrorFromTables,
  looksLikeProviderContextOverflowCandidate,
} from "./context-overflow-tables.js";
import {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isSessionTranscriptValidationErrorMessage,
  isTimeoutErrorMessage,
  matchesFormatErrorPattern,
} from "./message-patterns.js";
import type { classifyProviderPluginError } from "./provider-patterns.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";
type ProviderErrorClassifier = (
  context: Omit<Parameters<typeof classifyProviderPluginError>[0], "providerPlugin">,
) => FailoverReason | null;

const HTML_BODY_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
function isHtmlErrorResponse(raw: string): boolean {
  const candidate = raw
    .trim()
    .replace(/^error:\s*/i, "")
    .trim();
  const rest = extractLeadingHttpStatus(candidate)?.rest ?? candidate;
  return HTML_BODY_RE.test(rest) && HTML_CLOSE_RE.test(rest);
}

// These provider phrases take precedence over the generic message tables.
const PROVIDER_SPECIFIC_PATTERNS = [
  {
    test: /\bworkers_ai\b.*\bquota limit exceeded\b/i,
    reason: "rate_limit",
  },
  {
    test: /\bmodelnotreadyexception\b/i,
    reason: "overloaded",
  },
  // Groq does not currently ship a bundled provider hook.
  {
    test: /model(?:_is)?_deactivated|model has been deactivated/i,
    reason: "model_not_found",
  },
] as const;
function isTransportHtmlErrorStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 499 ||
    (typeof status === "number" && status >= 500 && status < 600)
  );
}
function classifyFailoverClassificationFromMessage(
  raw: string,
  provider?: string,
  errorType?: string,
): FailoverClassification | null {
  if (isImageDimensionErrorMessage(raw) || isImageSizeError(raw)) {
    return null;
  }
  if (isUnsupportedImageInputErrorMessage(raw)) {
    return toReasonClassification("format");
  }
  if (isClaudeCliAuthError(raw, provider)) {
    return toReasonClassification("auth");
  }
  if (isSessionTranscriptValidationErrorMessage(raw)) {
    return toReasonClassification("format");
  }
  if (isCliSessionExpiredErrorMessage(raw)) {
    return toReasonClassification("session_expired");
  }
  if (isModelNotFoundErrorMessage(raw)) {
    return toReasonClassification("model_not_found");
  }
  const legacyProviderReason = PROVIDER_SPECIFIC_PATTERNS.find(({ test }) =>
    test.test(raw),
  )?.reason;
  if (legacyProviderReason) {
    return toReasonClassification(legacyProviderReason);
  }
  if (isContextOverflowErrorFromTables(raw)) {
    return { kind: "context_overflow" };
  }
  if (isReplayInvalidErrorMessage(raw)) {
    return toReasonClassification("format");
  }
  const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
  if (reasonFrom402Text) {
    return toReasonClassification(reasonFrom402Text);
  }
  const leadingStatus = extractLeadingHttpStatus(raw.trim());
  if (leadingStatus?.code !== 429 && isBillingErrorMessage(raw)) {
    return toReasonClassification("billing");
  }
  if (isPeriodicUsageLimitErrorMessage(raw)) {
    return toReasonClassification(isBillingErrorMessage(raw) ? "billing" : "rate_limit");
  }
  if (isRateLimitErrorMessage(raw)) {
    return toReasonClassification("rate_limit");
  }
  if (isOverloadedErrorMessage(raw)) {
    return toReasonClassification("overloaded");
  }
  // Provider-completed `finish_reason: error` / stop-reason `error` is not a
  // hang. Classify as server_error (failover still runs) so operators do not
  // chase timeout knobs and user copy is not rewritten to "LLM request timed out."
  // (#109218; keep #59524 fallback by remaining a failover reason).
  if (isProviderCompletedErrorFinishReasonMessage(raw)) {
    return toReasonClassification("server_error");
  }
  if (
    isStructuredServerErrorMessage(raw) &&
    !isBillingErrorMessage(raw) &&
    !isAuthPermanentErrorMessage(raw) &&
    !isAuthErrorMessage(raw)
  ) {
    return toReasonClassification("server_error");
  }
  if (isGenericProviderInternalError(raw)) {
    return toReasonClassification("timeout");
  }
  // Auth classifiers run before the broad isJsonApiInternalServerError check so that
  // provider errors like {"type":"api_error","message":"invalid api key"} are
  // correctly classified as "auth" rather than "timeout".
  const oauthRefreshFailure = classifyOAuthRefreshFailure(raw);
  if (oauthRefreshFailure?.reason) {
    return toReasonClassification("auth_permanent");
  }
  if (isAuthPermanentErrorMessage(raw)) {
    return toReasonClassification("auth_permanent");
  }
  if (isAuthErrorMessage(raw)) {
    return toReasonClassification("auth");
  }
  if (
    isGenericUnknownStreamErrorMessage(raw) ||
    isServerErrorMessage(raw) ||
    isJsonApiInternalServerError(raw)
  ) {
    return toReasonClassification("timeout");
  }
  if (isCloudCodeAssistFormatError(raw)) {
    return toReasonClassification("format");
  }
  if (isExactUnknownNoDetailsError(raw)) {
    return toReasonClassification("no_error_details");
  }
  if (isTimeoutErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  if (matchesContextOverflowMessage(raw, "assistant-error")) {
    return { kind: "context_overflow" };
  }
  // Inspect raw and SDK-preserved types before the generic HTTP fallback, but
  // after more-specific text so invalid-request wrappers cannot hide an outage.
  const apiErrorReason = classifyCoreFailoverReasonFromErrorType(
    parseApiErrorInfo(raw)?.type ?? errorType,
  );
  if (apiErrorReason) {
    return toReasonClassification(apiErrorReason);
  }
  return classifyFailoverClassificationFromHttpStatus(
    inferSignalStatus({ message: raw }),
    raw,
    null,
    undefined,
    provider,
  );
}
function classifyFailoverDetailCandidates(
  details: readonly string[] | undefined,
  provider: string | undefined,
): FailoverClassification | null {
  for (const detail of details ?? []) {
    const classification = classifyFailoverClassificationFromMessage(detail, provider);
    if (classification) {
      return classification;
    }
  }
  return null;
}
function mergeMessageAndDetailClassification(
  messageClassification: FailoverClassification | null,
  detailClassification: FailoverClassification | null,
): FailoverClassification | null {
  if (!messageClassification || !detailClassification) {
    return messageClassification ?? detailClassification;
  }
  if (messageClassification.kind === "context_overflow") {
    return messageClassification;
  }
  if (detailClassification.kind === "context_overflow") {
    return detailClassification;
  }
  if (detailClassification.reason === "billing" && messageClassification.reason === "rate_limit") {
    return detailClassification;
  }
  return messageClassification.reason === "format" ? detailClassification : messageClassification;
}

function hasIndependentTransientMessage(
  raw: string | undefined,
  reason: FailoverReason,
  provider: string | undefined,
): boolean {
  const text = raw && (extractLeadingHttpStatus(raw)?.rest ?? raw);
  const info = parseApiErrorInfo(text);
  const payload = !info && text ? safeParseJsonRecord(text) : null;
  const prose = info
    ? info.message
    : payload
      ? typeof payload.message === "string"
        ? payload.message
        : undefined
      : text;
  return Boolean(
    prose &&
    classifyFailoverReasonFromCode(prose) !== reason &&
    failoverReasonFromClassification(classifyFailoverClassificationFromMessage(prose, provider)) ===
      reason,
  );
}

export function classifyFailoverSignalCore(
  signal: FailoverSignal,
  classifyProviderError?: ProviderErrorClassifier,
): FailoverClassification | null {
  const inferredStatus = inferSignalStatus(signal);
  const explicitStatus =
    typeof signal.status === "number" && Number.isFinite(signal.status) ? signal.status : undefined;
  const messageClassification = signal.message
    ? classifyFailoverClassificationFromMessage(signal.message, signal.provider, signal.errorType)
    : null;
  const detailClassification = classifyFailoverDetailCandidates(signal.details, signal.provider);
  const messageOrDetailClassification = mergeMessageAndDetailClassification(
    messageClassification,
    detailClassification,
  );
  const errorTypeReason = classifyCoreFailoverReasonFromErrorType(signal.errorType);
  const errorTypeClassification = errorTypeReason ? toReasonClassification(errorTypeReason) : null;
  // Provider-attributed 401/403/429 text is ambiguous enough to consult only the
  // scoped owner hook. Passing the inferred status also fences unresolved ids
  // from the descriptor-free broad scan in provider-runtime.
  const providerHookStatus =
    explicitStatus ??
    (signal.provider && (inferredStatus === 401 || inferredStatus === 403 || inferredStatus === 429)
      ? inferredStatus
      : undefined);
  // Pure table matches are also the cheap runtime-load gate. Structured,
  // context-shaped, and otherwise-unclassified signals still consult the
  // provider once; its result remains authoritative over the prepared tables.
  const hasProviderHookSignal = Boolean(
    signal.message || signal.code || signal.errorType || typeof inferredStatus === "number",
  );
  const hasStructuredDescriptor =
    providerHookStatus !== undefined || signal.code !== undefined || signal.errorType !== undefined;
  const hasContextCandidate = Boolean(
    signal.message && looksLikeProviderContextOverflowCandidate(signal.message),
  );
  const shouldConsultProviderPlugin =
    hasProviderHookSignal &&
    (hasStructuredDescriptor || hasContextCandidate || !messageClassification);
  let providerPluginReason: FailoverReason | null = null;
  if (shouldConsultProviderPlugin) {
    const context = {
      errorMessage: signal.message ?? "",
      provider: signal.provider,
      status: providerHookStatus,
      code: signal.code,
      errorType: signal.errorType,
    };
    providerPluginReason = classifyProviderError?.(context) ?? null;
  }
  const tlsCertificateError = inspectTlsCertificateError(signal);
  if (!providerPluginReason && tlsCertificateError && inferredStatus === undefined) {
    return toReasonClassification("tls_certificate");
  }
  if (
    !providerPluginReason &&
    signal.message &&
    isTransportHtmlErrorStatus(inferredStatus) &&
    isHtmlErrorResponse(signal.message)
  ) {
    // CDN page text is not a provider signal; classify its HTTP status through the shared owner.
    return classifyFailoverClassificationFromHttpStatus(
      inferredStatus,
      undefined,
      null,
      signal.status,
      signal.provider,
    );
  }
  // Message/detail semantics stay ahead of generic structured types so an
  // invalid-request wrapper cannot hide billing, context, or provider policy.
  const codeReason =
    classifyFailoverReasonFromCode(signal.code) ??
    classifyFailoverReasonFromCode(parseApiErrorInfo(signal.message)?.code);
  // A validation code identifies the rejected operation; arbitrary parameter
  // text must not turn it into an unrelated failure through message matching.
  const effectiveMessageClassification = providerPluginReason
    ? toPluginClassification(providerPluginReason)
    : codeReason === "format"
      ? toReasonClassification("format")
      : mergeMessageAndDetailClassification(
          messageOrDetailClassification ?? errorTypeClassification,
          codeReason ? toReasonClassification(codeReason) : null,
        );
  if (codeReason === "auth_permanent") {
    return toReasonClassification(codeReason);
  }
  const statusClassification = classifyFailoverClassificationFromHttpStatus(
    inferredStatus,
    signal.message,
    effectiveMessageClassification,
    signal.status,
    signal.provider,
    { preserveProviderSignalClassification: providerPluginReason !== null },
  );
  const classification =
    statusClassification ??
    (codeReason ? toReasonClassification(codeReason) : effectiveMessageClassification);
  if (
    !providerPluginReason &&
    inferredStatus !== undefined &&
    inferredStatus >= 400 &&
    inferredStatus < 500 &&
    inferredStatus !== 408 &&
    inferredStatus !== 409 &&
    inferredStatus !== 410 &&
    inferredStatus !== 429 &&
    inferredStatus !== 499 &&
    classification?.kind === "reason" &&
    classification.reason === codeReason &&
    (codeReason === "rate_limit" || codeReason === "overloaded" || codeReason === "timeout")
  ) {
    // Inspect prose, not the JSON code that supplied the presentation reason.
    // Bedrock throttling text and provider-owned decisions remain retryable.
    const info = parseApiErrorInfo(signal.message);
    const hasTransientProse =
      hasIndependentTransientMessage(signal.message, codeReason, signal.provider) ||
      signal.details?.some((detail) =>
        hasIndependentTransientMessage(detail, codeReason, signal.provider),
      );
    if (!hasTransientProse && !/^throttling_?exception$/i.test(signal.code ?? info?.code ?? "")) {
      return { ...classification, sameModelRetry: false };
    }
  }
  return classification;
}
export function isCloudCodeAssistFormatError(raw: string): boolean {
  return !isImageDimensionErrorMessage(raw) && matchesFormatErrorPattern(raw);
}

// Transient signal patterns for api_error payloads. Only treat an api_error as
// retryable when the message text itself indicates a transient server issue.
// Non-transient api_error payloads (context overflow, validation/schema errors)
// must NOT be classified as timeout.
const API_ERROR_TRANSIENT_SIGNALS_RE =
  /internal server error|overload|temporarily unavailable|service unavailable|unknown error|server error|bad gateway|gateway timeout|upstream error|backend error|try again later|temporarily.+unable|unexpected error/i;

function isJsonApiInternalServerError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  // Providers wrap transient 5xx errors in JSON payloads like:
  // {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
  // Non-standard providers (e.g. MiniMax) may use different message text:
  // {"type":"api_error","message":"unknown error, 520 (1000)"}
  if (!value.includes('"type":"api_error"')) {
    return false;
  }
  // Leading 429 wrappers defer billing classification to the HTTP policy below.
  if (isBillingErrorMessage(raw)) {
    return false;
  }
  // Only match when the message contains a transient signal. api_error payloads
  // with non-transient messages (e.g. context overflow, schema validation) should
  // fall through to more specific classifiers or remain unclassified.
  return API_ERROR_TRANSIENT_SIGNALS_RE.test(raw);
}

function isStructuredServerErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const parsedType = normalizeOptionalLowercaseString(parseApiErrorInfo(raw)?.type);
  if (parsedType === "server_error" || parsedType === "upstream_error") {
    return true;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  return (
    value.includes('"type":"server_error"') ||
    value.includes('"code":"server_error"') ||
    value.includes('"type":"upstream_error"') ||
    value.includes('"code":"upstream_error"')
  );
}

function isCliSessionExpiredErrorMessage(raw: string): boolean {
  return /\b(?:session (?:not found|does not exist|expired|invalid)|conversation (?:not found|does not exist|expired|invalid)|no conversation found|no such session|invalid session|(?:session|conversation) id not found)\b/.test(
    normalizeLowercaseStringOrEmpty(raw),
  );
}

export function classifyFailoverReasonCore(
  raw: string,
  opts?: { provider?: string },
  classifyProviderError?: ProviderErrorClassifier,
): FailoverReason | null {
  return failoverReasonFromClassification(
    classifyFailoverSignalCore({ message: raw, provider: opts?.provider }, classifyProviderError),
  );
}
