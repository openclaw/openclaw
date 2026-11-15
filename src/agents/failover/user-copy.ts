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
import { resolveMessageLocale } from "../../shared/message-locale.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import {
  API_KEY_EXPIRED_ERROR_CODE,
  ERROR_PREFIX_RE,
  renderAssistantRequestFailureCopy,
} from "./assistant-request-failure-copy.js";
import { classifyFailoverReasonCore } from "./classify-core.js";
import {
  AUTH_PROFILE_COOLDOWN_ERROR_CODE,
  CLI_LIVE_SESSION_HOST_MEMORY_ERROR_CODE,
  MODEL_CHAT_UNSUPPORTED_TEXT,
  type CliTimeoutContext,
  type FallbackAttemptRecord,
} from "./error.js";
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
import { messageCopy } from "./user-message-catalog.js";

export const AUTH_INVALID_TOKEN_USER_TEXT = messageCopy("en", "AUTH_INVALID_TOKEN_USER_TEXT");
export const TLS_CERTIFICATE_ERROR_USER_TEXT = messageCopy("en", "TLS_CERTIFICATE_ERROR_USER_TEXT");
export const OAUTH_REFRESH_CONTENTION_USER_TEXT = messageCopy(
  "en",
  "OAUTH_REFRESH_CONTENTION_USER_TEXT",
);
export const renderFailoverCodeUserCopy = (code: unknown, locale?: string): string | undefined =>
  code === "model_chat_unsupported"
    ? MODEL_CHAT_UNSUPPORTED_TEXT
    : code === "selected_auth_profile_unavailable"
      ? messageCopy(locale, "SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT")
      : code === AUTH_PROFILE_COOLDOWN_ERROR_CODE
        ? messageCopy(locale, "RATE_LIMIT_ERROR_USER_MESSAGE")
        : code === "refresh_contention"
          ? messageCopy(locale, "OAUTH_REFRESH_CONTENTION_USER_TEXT")
          : code === CLI_LIVE_SESSION_HOST_MEMORY_ERROR_CODE
            ? "⚠️ This host is low on memory, so it could not start another session. Try again after active conversations finish."
            : undefined;
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again (?:in|at)\b|\bresets?\b|\bplan\b|\bquota\b|重置|分钟|小时|秒后|额度|配额/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context (?:length|window) exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const PROVIDER_PROMPT_SIZE_LIMIT_RE =
  /\b(?:this\s+)?prompt\s+(?:is\s+)?(?:too long|longer than)\b.{0,120}\b(?:free tier|single request|per[- ]request)\b/i;
const PROVIDER_PROMPT_SIZE_ERROR_PARSE_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;

/** Format billing copy with optional provider/model and credential context. */
export function formatBillingErrorMessage(
  provider?: string,
  model?: string,
  authMode?: string,
  locale?: string,
): string {
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  const isSubscriptionAuth = authMode === "oauth" || authMode === "token";
  if (resolveMessageLocale(locale) === "de") {
    const providerDisplayName = providerLabel ?? "Der KI-Dienst";
    return isSubscriptionAuth
      ? `⚠️ ${providerDisplayName} meldet ein Abrechnungsproblem. Prüfe dein Abonnement und die Nutzungslimits und versuche es dann erneut.`
      : `⚠️ ${providerDisplayName} meldet ein Abrechnungsproblem. Prüfe dein Guthaben und die Nutzungslimits, bevor du es erneut versuchst.`;
  }
  if (isSubscriptionAuth) {
    return `⚠️ ${providerLabel ?? "API provider"} returned a billing error — check your account for subscription or usage limits, then try again.`;
  }
  return providerLabel
    ? `⚠️ ${providerLabel} returned a billing error — check your account's balance and usage limits before trying again.`
    : "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.";
}

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

function renderProviderPromptSizeLimitCopy(raw: string, locale?: string): string | undefined {
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
    ? messageCopy(locale, "PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE")
    : undefined;
}

/** Render only controller-recorded exhaustion, never infer it from provider text. */
export function renderRateLimitRetryExhaustion(
  retries: number | undefined,
  finalModel = false,
  locale?: string,
): string | undefined {
  if (retries === undefined) {
    return undefined;
  }
  if (resolveMessageLocale(locale) === "de") {
    const scope = finalModel ? " beim letzten Modell" : "";
    return retries === 0
      ? `Automatische Wiederholungen bei Nutzungslimits sind${scope} für dieses Gespräch deaktiviert (retry.provider.maxRetries: 0).`
      : `Nach ${retries === 1 ? "einem automatischen Wiederholungsversuch" : `${retries} automatischen Wiederholungsversuchen`}${scope} liegt noch keine vollständige Modellantwort vor. Prüfe bereits erledigte Arbeit, bevor du es erneut versuchst.`;
  }
  const scope = finalModel ? " on the final model" : "";
  return retries === 0
    ? `Automatic rate-limit recovery is disabled${scope} for this session (retry.provider.maxRetries: 0).`
    : `Rate-limit recovery stopped${scope} after ${retries} automatic ${retries === 1 ? "retry" : "retries"} without a completed model response. Check completed work before trying again.`;
}

/** A watchdog stop mid-backoff interrupted recovery; zero retries never means it was disabled. */
export function renderRateLimitRecoveryStopped(retries: number, locale?: string): string {
  if (resolveMessageLocale(locale) === "de" && retries <= 0) {
    return "Die automatische Wiederholung wurde ohne vollständige Modellantwort beendet. Prüfe bereits erledigte Arbeit, bevor du es erneut versuchst.";
  }
  return (
    (retries > 0 && renderRateLimitRetryExhaustion(retries, false, locale)) ||
    "Rate-limit recovery stopped without a completed model response. Check completed work before trying again."
  );
}

type RateLimitResetContext = {
  rateLimitResetAt?: number;
  provider?: string;
  model?: string;
  locale?: string;
  timeZone?: string;
  nowMs?: number;
};

/** Provider deadlines outrank generic retry advice; diagnostic bodies never become this copy. */
export function renderRateLimitResetCopy(params: RateLimitResetContext): string | undefined {
  const resetAt = params.rateLimitResetAt ?? 0;
  const remainingMs = resetAt - (params.nowMs ?? Date.now());
  if (remainingMs <= 60_000 || !Number.isFinite(remainingMs)) {
    return undefined;
  }
  const unit = remainingMs >= 86_400_000 ? "day" : remainingMs >= 3_600_000 ? "hour" : "minute";
  const divisor = unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 60_000;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: params.timeZone,
  };
  let absolute: string;
  let relative: string;
  try {
    absolute = new Intl.DateTimeFormat(resolveMessageLocale(params.locale), options).format(
      resetAt,
    );
    relative = new Intl.RelativeTimeFormat(resolveMessageLocale(params.locale)).format(
      Math.ceil(remainingMs / divisor),
      unit,
    );
  } catch {
    // Invalid saved display preferences must not hide the provider's reset.
    absolute = new Date(resetAt).toISOString();
    relative = new Intl.RelativeTimeFormat("en").format(Math.ceil(remainingMs / divisor), unit);
  }
  const route = [params.provider, params.model].filter(Boolean).join("/") || "This model";
  if (resolveMessageLocale(params.locale) === "de") {
    return `⚠️ Das Nutzungslimit für ${route} ist erreicht. Laut Anbieter kannst du es ${relative} (${absolute}) erneut versuchen. Wähle ein anderes Modell oder konfiguriere Ersatzmodelle in den Einstellungen (\`agents.defaults.model.fallbacks\`).`;
  }
  return `⚠️ ${route} is rate-limited. The provider says to retry ${relative} (${absolute}). Choose another model in the model picker, or configure Model fallbacks in Settings (\`agents.defaults.model.fallbacks\`).`;
}

/** Render rate-limit versus overload copy from the canonical classified reason. */
export function renderRateLimitOrOverloadedCopy(
  params: RateLimitResetContext & {
    reason: Extract<FailoverReason, "rate_limit" | "overloaded">;
    raw?: string;
    rateLimitRetriesExhausted?: number;
  },
): string {
  const resetCopy = params.reason === "rate_limit" ? renderRateLimitResetCopy(params) : undefined;
  if (resetCopy) {
    return resetCopy;
  }
  const exhaustion =
    params.reason === "rate_limit"
      ? renderRateLimitRetryExhaustion(params.rateLimitRetriesExhausted, false, params.locale)
      : undefined;
  if (exhaustion) {
    return exhaustion;
  }
  const raw = params.raw ?? "";
  if (MODEL_CAPACITY_ERROR_RE.test(raw)) {
    return messageCopy(params.locale, "MODEL_CAPACITY_ERROR_USER_MESSAGE");
  }
  if (params.reason === "overloaded") {
    return messageCopy(params.locale, "OVERLOADED_ERROR_USER_MESSAGE");
  }
  const promptSizeCopy = renderProviderPromptSizeLimitCopy(raw, params.locale);
  if (promptSizeCopy) {
    return promptSizeCopy;
  }
  for (const leg of splitFailoverAggregateLegs(raw)) {
    const fromLeg = extractProviderRateLimitMessage(leg);
    if (fromLeg) {
      return fromLeg;
    }
  }
  return (
    extractProviderRateLimitMessage(raw) ??
    messageCopy(params.locale, "RATE_LIMIT_ERROR_USER_MESSAGE")
  );
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
  opts?: { errorContext?: boolean; locale?: string },
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
    return resolveMessageLocale(opts?.locale) === "de"
      ? "Die Anfrage ist zu groß für dieses Modell. Kürze sie oder wähle ein Modell mit einem größeren Kontextfenster."
      : CONTEXT_OVERFLOW_ERROR_MESSAGE;
  }
  if (reason === "billing" || reason === "rate_limit" || reason === "overloaded") {
    return reason === "billing"
      ? formatBillingErrorMessage(undefined, undefined, undefined, opts?.locale)
      : renderRateLimitOrOverloadedCopy({ reason, raw: trimmed, locale: opts?.locale });
  }
  // Labeled HTTP statuses require the full grammar; keep provider retry detail above.
  const providerRequestCode = resolveProviderRequestFailureCode({
    classification: reason ? { kind: "reason", reason } : null,
    facet: null,
    status: extractErrorHttpStatus(trimmed)?.code,
  });
  if (providerRequestCode) {
    return renderProviderRequestCodeCopy(providerRequestCode, opts?.locale);
  }
  if (isGenericProviderInternalError(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (reason === "timeout" && resolveMessageLocale(opts?.locale) === "de") {
    return (
      formatTransportErrorCopy(trimmed, "de") ??
      renderAssistantRequestFailureCopy({ reason: "timeout" }, "de") ??
      sanitized
    );
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
    const transport = formatTransportErrorCopy(trimmed, opts?.locale);
    if (transport) {
      return transport;
    }
    if (isProviderCompletedErrorFinishReasonMessage(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (reason === "timeout") {
      return resolveMessageLocale(opts?.locale) === "de"
        ? "Die Modellanfrage hat zu lange gedauert."
        : "LLM request timed out.";
    }
    return formatRawAssistantErrorForUi(trimmed);
  }
  return sanitized;
}

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT = messageCopy(
  "en",
  "GENERIC_EXTERNAL_RUN_FAILURE_TEXT",
);

export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE = messageCopy(
  "en",
  "PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE",
);
const PROVIDER_REQUEST_COPY_KEYS = {
  provider_authentication_error: "AUTH_INVALID_TOKEN_USER_TEXT",
  provider_conversation_state_error: "PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE",
  provider_internal_error: "PROVIDER_INTERNAL_ERROR_USER_MESSAGE",
  provider_model_unavailable: "PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE",
  provider_rate_limit_or_quota_error: "PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE",
} as const;

type ProviderRequestErrorCode = keyof typeof PROVIDER_REQUEST_COPY_KEYS;

export function renderProviderRequestCodeCopy(
  code: ProviderRequestErrorCode,
  locale?: string,
): string {
  const text = messageCopy(locale, PROVIDER_REQUEST_COPY_KEYS[code]);
  return code === "provider_authentication_error" ? `⚠️ ${text}` : text;
}

function resolveProviderRequestFailureCode(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
  code?: string;
}): ProviderRequestErrorCode | undefined {
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  if (reason === "auth" && params.status === 401) {
    // An expired key cannot be fixed by signing in; its copy is rendered from the provider code.
    return params.code === API_KEY_EXPIRED_ERROR_CODE ? undefined : "provider_authentication_error";
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
  code?: string;
  locale?: string;
}) {
  const code = resolveProviderRequestFailureCode(params);
  if (!code) {
    return undefined;
  }
  return {
    code,
    userMessage: renderProviderRequestCodeCopy(code, params.locale),
  };
}

export type ReplyFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

/** Render the reply surface's rate-limit copy, including structured cooldown context. */
export function renderRateLimitReplyCopy(
  params: RateLimitResetContext & {
    message: string;
    reason?: FailoverReason;
    code?: string;
    attempts?: readonly ReplyFallbackAttempt[];
    rateLimitRetriesExhausted?: number;
    cooldownExpiry?: number | null;
    sanitizeText?: (text: string) => string;
  },
): string {
  const attempts = params.attempts ?? [];
  const limited = attempts.find(
    (attempt) =>
      attempt.reason === "rate_limit" &&
      (attempt.rateLimitResetAt ?? 0) > (params.nowMs ?? Date.now()) + 60_000,
  );
  const resetCopy = renderRateLimitResetCopy(limited ? { ...params, ...limited } : params);
  if (resetCopy && !attempts.some((attempt) => attempt.reason === "billing")) {
    return resetCopy;
  }
  // Host-authored failures keep their own copy; cooldown copy below adds expiry detail.
  const code = params.code ?? attempts.at(-1)?.code;
  const codeCopy =
    code === AUTH_PROFILE_COOLDOWN_ERROR_CODE
      ? undefined
      : renderFailoverCodeUserCopy(code, params.locale);
  if (codeCopy) {
    return codeCopy;
  }
  // Local cooldown diagnostics name the operator's saved login; only provider text becomes copy.
  const providerMessage = params.code === AUTH_PROFILE_COOLDOWN_ERROR_CODE ? "" : params.message;
  if (params.reason === "rate_limit") {
    const promptSizeCopy = renderProviderPromptSizeLimitCopy(params.message, params.locale);
    if (promptSizeCopy) {
      return promptSizeCopy;
    }
  }
  const exhaustion =
    params.reason === "rate_limit" && !attempts.some((attempt) => attempt.reason === "billing")
      ? renderRateLimitRetryExhaustion(
          attempts.length
            ? attempts.at(-1)?.rateLimitRetriesExhausted
            : params.rateLimitRetriesExhausted,
          attempts.length > 1,
          params.locale,
        )
      : undefined;
  if (exhaustion) {
    return exhaustion;
  }
  const { reason: directReason, provider: directProvider, sanitizeText } = params;
  const usageAttempt = attempts.find(
    (candidate) =>
      candidate.provider === "openai" &&
      candidate.reason === "rate_limit" &&
      candidate.code !== AUTH_PROFILE_COOLDOWN_ERROR_CODE &&
      candidate.error,
  );
  const text =
    usageAttempt?.error ??
    (directProvider === "openai" && directReason === "rate_limit" ? providerMessage : undefined);
  if (text) {
    const message = renderSanitizedUserFacingText(sanitizeText?.(text) ?? text, {
      errorContext: true,
      locale: params.locale,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (message) {
      const truncated = message.length > 500 ? `${truncateUtf16Safe(message, 497)}...` : message;
      return truncated.startsWith("⚠️") ? truncated : `⚠️ ${truncated}`;
    }
  }

  if (attempts.some((attempt) => attempt.reason === "billing") || params.reason === "billing") {
    return formatBillingErrorMessage(undefined, undefined, undefined, params.locale);
  }
  if (attempts.length === 0) {
    if (params.reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(providerMessage)) {
      const copy = renderSanitizedUserFacingText(
        params.sanitizeText?.(providerMessage) ?? providerMessage,
        { errorContext: true, locale: params.locale },
      );
      return copy.startsWith("⚠️") ? copy : `⚠️ ${copy}`;
    }
    return messageCopy(params.locale, "RATE_LIMIT_ERROR_USER_MESSAGE");
  }
  for (const attempt of attempts) {
    if (
      attempt.reason !== "rate_limit" ||
      attempt.code === AUTH_PROFILE_COOLDOWN_ERROR_CODE ||
      !attempt.error
    ) {
      continue;
    }
    const hint = extractProviderRateLimitMessage(attempt.error);
    if (hint) {
      return params.sanitizeText?.(hint) ?? hint;
    }
  }
  const expiry = params.cooldownExpiry;
  const nowMs = params.nowMs ?? Date.now();
  if (typeof expiry === "number" && expiry > nowMs) {
    const secsLeft = Math.max(1, Math.ceil((expiry - nowMs) / 1000));
    if (resolveMessageLocale(params.locale) === "de") {
      return `⚠️ Der KI-Dienst benötigt eine kurze Pause. Bitte versuche es in etwa ${secsLeft <= 60 ? `${secsLeft} Sekunden` : `${Math.ceil(secsLeft / 60)} Minuten`} erneut.`;
    }
    return secsLeft <= 60
      ? `⚠️ The AI service needs a short break. Please try again in ~${secsLeft}s.`
      : `⚠️ The AI service needs a short break. Please try again in ~${Math.ceil(secsLeft / 60)} min.`;
  }
  const attemptedModels = new Set(
    attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
  );
  return attemptedModels.size > 1 &&
    attempts.every((attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded")
    ? resolveMessageLocale(params.locale) === "de"
      ? "⚠️ Die KI-Dienste sind ausgelastet. Bitte versuche es in wenigen Minuten erneut."
      : "⚠️ The AI services are busy. Please try again in a few minutes."
    : messageCopy(params.locale, "RATE_LIMIT_ERROR_USER_MESSAGE");
}

export function renderBillingReplyCopy(params: {
  locale?: string;
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
        params.locale,
      )
    : formatBillingErrorMessage(undefined, undefined, undefined, params.locale);
}

const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE =
  /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE =
  /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;
const CODEX_SESSION_GENERATION_NOT_CURRENT_RE =
  /\bcodex session generation is no longer current\b/iu;
const CODEX_EXECUTION_NODE_DISCONNECTED_RE =
  /^Codex execution node disconnected; start a fresh attempt\. \((?:execution node (?:failed|disconnected)|execution socket (?:closed|failed))(?:: [^\r\n]{1,240})?\)(?:\r?\n|$)/u;

export function renderCodexAppServerFailureCopy(message: string, locale?: string): string | null {
  const normalizedMessage = message.trim();
  if (resolveMessageLocale(locale) === "de") {
    if (CODEX_SESSION_GENERATION_NOT_CURRENT_RE.test(normalizedMessage)) {
      return "⚠️ Diese Codex-Sitzung hat sich geändert, bevor deine Nachricht verarbeitet werden konnte. Sende sie bitte erneut.";
    }
    if (CODEX_EXECUTION_NODE_DISCONNECTED_RE.test(normalizedMessage)) {
      return "⚠️ Die Verbindung zum Codex-Ausführungsgerät wurde getrennt. Starte einen neuen Versuch.";
    }
    if (
      CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage) ||
      CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)
    ) {
      return "⚠️ Codex hat den Abschluss der Aufgabe noch nicht bestätigt. Sie läuft möglicherweise weiter. Prüfe den Gesprächsverlauf in der OpenClaw-App, bevor du es erneut versuchst.";
    }
  }
  if (CODEX_SESSION_GENERATION_NOT_CURRENT_RE.test(normalizedMessage)) {
    return "⚠️ This Codex session changed before your message could run. Please send it again.";
  }
  if (CODEX_EXECUTION_NODE_DISCONNECTED_RE.test(normalizedMessage)) {
    return "⚠️ Codex execution node disconnected. Start a fresh attempt.";
  }
  if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) {
    return "⚠️ Lost the connection to Codex before it confirmed the task was finished. It may still be running. Check the conversation in the OpenClaw app before trying again.";
  }
  if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) {
    return "⚠️ Codex hasn't confirmed whether the task finished. It may still be running. Check the conversation in the OpenClaw app before trying again.";
  }
  return null;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;

export function renderCliTimeoutReplyCopy(params: {
  locale?: string;
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
  if (resolveMessageLocale(params.locale) === "de") {
    const summary =
      mode === "no-output"
        ? "Die Aufgabe reagiert nicht mehr."
        : "Die Aufgabe hat zu lange gedauert.";
    const work = mayHaveCompletedWork
      ? " Einige Schritte können bereits erledigt sein. Prüfe die Ergebnisse, bevor du es erneut versuchst."
      : "";
    const remedy =
      mode === "no-output"
        ? "Prüfe im Terminal, ob eine Anmeldung oder Bestätigung aussteht."
        : "Versuche eine kleinere Aufgabe oder erhöhe das Zeitlimit in den Einstellungen der OpenClaw-App.";
    return `⚠️ ${summary}${work} ${remedy}`;
  }
  const workStatus = mayHaveCompletedWork
    ? " Some work may have completed. Check its results before trying again."
    : "";
  const summary = mode === "no-output" ? "The task stopped responding." : "The task took too long.";
  const remedy =
    mode === "no-output"
      ? "Check for a sign-in or confirmation prompt in the terminal."
      : "Try a smaller task, or increase the task time limit in the OpenClaw app settings.";
  return `⚠️ ${summary}${workStatus} ${remedy}`;
}
