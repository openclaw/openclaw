import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  REPETITIVE_OUTPUT_ERROR_MESSAGE,
  REPEATED_TOOL_ERROR_CODE,
  REPEATED_TOOL_ERROR_MESSAGE,
} from "../../../packages/agent-core/src/errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { REPETITIVE_OUTPUT_ERROR_CODE, type AssistantMessage } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  formatProviderRefusalText,
  formatRawAssistantErrorForUi,
  formatTransportErrorCopy,
  isGenericProviderInternalError,
  isKnownTransportErrorCode,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { resolveMessageLocale, type MessageLocale } from "../../shared/message-locale.js";
import {
  PROVIDER_SCHEMA_REJECTION_USER_TEXT,
  renderAssistantFormatFailureCopy,
  renderAssistantRequestFailureCopy,
  renderFormatErrorCopy,
  renderModelLoadFailureCopy,
} from "../failover/assistant-request-failure-copy.js";
import { failoverReasonFromClassification } from "../failover/classification-rules.js";
import {
  classifyFailoverSignal,
  isProviderCompletedErrorFinishReasonMessage,
  isTimeoutErrorMessage,
} from "../failover/classify.js";
import { isReasoningConstraintErrorMessage } from "../failover/context-overflow-tables.js";
import { resolveExecutionApprovalFailureMessage } from "../failover/message-patterns.js";
import type { PreparedProviderFailoverOwner } from "../failover/provider-patterns.js";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  OAUTH_REFRESH_CONTENTION_USER_TEXT,
  TLS_CERTIFICATE_ERROR_USER_TEXT,
  formatBillingErrorMessage,
  formatDiskSpaceErrorCopy,
  isInvalidStreamingEventOrderError,
  isLikelyHttpErrorText,
  isRawApiErrorPayload,
  isStreamingJsonParseError,
  renderRateLimitOrOverloadedCopy,
} from "../failover/user-copy.js";
import { messageCopy } from "../failover/user-message-catalog.js";
import { MODEL_REQUEST_POLICY_DENIED_TEXT } from "../harness/errors.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  type resolveSandboxRuntimeStatus,
} from "../sandbox/runtime-status.js";
import { readRepeatedToolErrorSummary } from "../tool-error-summary.js";
import { buildAssistantFailoverSignal } from "./assistant-message-failures.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";
const log = createSubsystemLogger("errors");
const sandboxToolPolicyAuditMessages = new WeakSet<AssistantMessage>();
export const GENERIC_ASSISTANT_ERROR_TEXT = "LLM request failed.";
export const SYNTHESIZED_TIMEOUT_ERROR_TEXT = "LLM request timed out.";
const MODEL_NOT_FOUND_USER_TEXT =
  "This model was not found. Choose another model in the OpenClaw app.";
const RUNTIME_FAILURE_COPY: Partial<
  Record<ReturnType<typeof classifyProviderRuntimeFailureKind>, Record<MessageLocale, string>>
> = {
  auth_refresh: {
    en: "Couldn't sign in to the AI service. Sign in again under Models in the OpenClaw app or run `openclaw configure`.",
    de: "Die Anmeldung beim KI-Dienst ist fehlgeschlagen. Melde dich unter Modelle in der OpenClaw-App erneut an oder führe `openclaw configure` aus.",
  },
  refresh_contention: {
    en: OAUTH_REFRESH_CONTENTION_USER_TEXT,
    de: "Eine andere Anmeldung läuft noch. Warte einen Moment und versuche es erneut.",
  },
  refresh_timeout: {
    en: "Signing in took too long. Try again in a moment. If it keeps happening, sign in again under Models in the OpenClaw app.",
    de: "Die Anmeldung hat zu lange gedauert. Versuche es gleich erneut. Melde dich bei anhaltenden Problemen unter Modelle in der OpenClaw-App erneut an.",
  },
  callback_timeout: {
    en: "Sign-in wasn't completed. Try signing in again. If asked for a link, paste the full link from your browser.",
    de: "Die Anmeldung wurde nicht abgeschlossen. Versuche es erneut. Falls ein Link benötigt wird, füge den vollständigen Link aus deinem Browser ein.",
  },
  callback_validation: {
    en: "The sign-in link wasn't accepted. Try signing in again. If asked for a link, paste the full link from your browser.",
    de: "Der Anmeldelink wurde nicht akzeptiert. Versuche es erneut. Falls ein Link benötigt wird, füge den vollständigen Link aus deinem Browser ein.",
  },
  auth_scope: {
    en: "This login doesn't have the access OpenClaw needs. Sign in again under Models in the OpenClaw app.",
    de: "Dieser Anmeldung fehlen die von OpenClaw benötigten Berechtigungen. Melde dich unter Modelle in der OpenClaw-App erneut an.",
  },
  auth_html: {
    en: "Couldn't sign in to the AI service. Sign in again under Models in the OpenClaw app or run `openclaw configure`.",
    de: "Die Anmeldung beim KI-Dienst ist fehlgeschlagen. Melde dich unter Modelle in der OpenClaw-App erneut an oder führe `openclaw configure` aus.",
  },
  auth_invalid_token: {
    en: AUTH_INVALID_TOKEN_USER_TEXT,
    de: "Die Anmeldung beim KI-Dienst ist fehlgeschlagen. Melde dich unter Modelle in der OpenClaw-App erneut an oder führe `openclaw configure` aus.",
  },
  upstream_html: {
    en: "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.",
    de: "Der KI-Dienst ist nicht erreichbar. Versuche es gleich erneut. Details findest du bei anhaltenden Problemen unter Einstellungen → Protokolle oder mit `openclaw logs --follow`.",
  },
  proxy: {
    en: "Couldn't connect to the AI service. For details, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.",
    de: "Die Verbindung zum KI-Dienst ist fehlgeschlagen. Details findest du unter Einstellungen → Protokolle oder mit `openclaw logs --follow`.",
  },
  tls_certificate: {
    en: TLS_CERTIFICATE_ERROR_USER_TEXT,
    de: "Die sichere Verbindung zum KI-Dienst ist fehlgeschlagen. Details findest du unter Einstellungen → Protokolle oder mit `openclaw logs --follow`.",
  },
  model_not_found: {
    en: MODEL_NOT_FOUND_USER_TEXT,
    de: "Dieses Modell wurde nicht gefunden. Wähle ein anderes Modell in der OpenClaw-App.",
  },
};
const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;
type AssistantErrorTextOptions = {
  locale?: string;
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  provider?: string;
  providerOwner?: PreparedProviderFailoverOwner;
  model?: string;
  /** Credential auth mode; OAuth/token billing copy omits API-key language (#80877). */
  authMode?: string;
  sandboxRuntime?: ReturnType<typeof resolveSandboxRuntimeStatus>;
};
type ClassifiedAssistantErrorFacts = ReturnType<typeof classifyAssistantErrorFacts>;
function classifyAssistantErrorFacts(msg: AssistantMessage, opts?: AssistantErrorTextOptions) {
  const signal = buildAssistantFailoverSignal(msg, {
    provider: opts?.providerOwner?.id ?? opts?.provider,
  });
  // Both projections share the complete signal and explicit owner. Raw schema
  // evidence stays distinct from the full classification used for safe copy.
  const providerPlugin = opts?.providerOwner ?? null;
  const classification = classifyFailoverSignal(signal, { providerPlugin });
  return {
    provider: opts?.provider ?? msg.provider ?? opts?.providerOwner?.id,
    model: opts?.model ?? msg.model,
    reason: failoverReasonFromClassification(classification),
    status: signal.status ?? extractErrorHttpStatus(signal.message ?? "")?.code,
    providerRuntimeFailureKind: classifyProviderRuntimeFailureKind(signal, { providerPlugin }),
    storageFailure: classifyGatewayStorageFailure(msg),
    code: signal.code,
    rateLimitResetAt:
      signal.retryAfterMs === undefined ? undefined : Date.now() + signal.retryAfterMs,
  };
}
export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: AssistantErrorTextOptions,
  facts?: ClassifiedAssistantErrorFacts,
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) {
    return undefined;
  }
  const providerRefusalText = formatProviderRefusalText(msg);
  if (providerRefusalText) {
    return providerRefusalText;
  }
  const locale = resolveMessageLocale(opts?.locale, opts?.cfg?.messages?.locale);
  const formatCopy = renderFormatErrorCopy(raw);
  const classifiedFacts = facts ?? classifyAssistantErrorFacts(msg, opts);
  if (classifiedFacts.storageFailure) {
    return renderAssistantRequestFailureCopy(classifiedFacts);
  }
  const {
    reason: failoverReason,
    status: formatStatus,
    providerRuntimeFailureKind,
  } = classifiedFacts;
  if (formatStatus === 403 && (msg.errorType ?? parseApiErrorInfo(raw)?.type) === "FreeTierError") {
    return locale === "de"
      ? "Der kostenlose Tarif dieses Modells ist auf die Anwendung des Anbieters beschränkt. Wähle ein anderes Modell oder nutze einen kostenpflichtigen Tarif."
      : "This model's free tier is limited to the provider's own client. Choose another model or use a paid plan.";
  }
  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  // Error formatting uses prepared policy only; missing facts preserve the provider error.
  if (unknownTool?.[1] && opts?.sandboxRuntime) {
    const audit = !sandboxToolPolicyAuditMessages.has(msg);
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      agentId: opts?.agentId,
      toolName: unknownTool[1],
      preparedRuntimeStatus: opts.sandboxRuntime,
      audit,
    });
    if (rewritten) {
      if (audit) {
        sandboxToolPolicyAuditMessages.add(msg);
      }
      return rewritten;
    }
  }
  const diskSpaceCopy = formatDiskSpaceErrorCopy(raw);
  if (diskSpaceCopy) {
    return diskSpaceCopy;
  }
  const runtimeCopy = RUNTIME_FAILURE_COPY[providerRuntimeFailureKind]?.[locale];
  if (runtimeCopy) {
    return runtimeCopy;
  }
  if (failoverReason === "billing") {
    return formatBillingErrorMessage(
      opts?.provider,
      opts?.model ?? msg.model,
      opts?.authMode,
      locale,
    );
  }
  const transientCopy =
    failoverReason === "rate_limit" || failoverReason === "overloaded"
      ? renderRateLimitOrOverloadedCopy({
          ...classifiedFacts,
          reason: failoverReason,
          raw,
          locale,
          timeZone: opts?.cfg?.agents?.defaults?.userTimezone,
        })
      : undefined;
  if (transientCopy) {
    return transientCopy;
  }

  if (
    (formatStatus === 400 || formatStatus === 422) &&
    formatCopy !== PROVIDER_SCHEMA_REJECTION_USER_TEXT &&
    !formatCopy.startsWith("LLM request rejected:")
  ) {
    return renderFormatErrorCopy(raw, { locale });
  }
  if (failoverReason === "context_overflow") {
    return locale === "de"
      ? messageCopy(locale, "CONTEXT_OVERFLOW_ERROR_USER_MESSAGE")
      : CONTEXT_OVERFLOW_ERROR_MESSAGE;
  }
  if (isReasoningConstraintErrorMessage(raw)) {
    if (locale === "de") {
      return "Dieser Modell-Endpunkt erfordert Reasoning. Verwende /think minimal oder eine andere Stufe als off und versuche es erneut.";
    }
    return (
      "Reasoning is required for this model endpoint. " +
      "Use /think minimal (or any non-off level) and try again."
    );
  }

  if (isInvalidStreamingEventOrderError(raw)) {
    return locale === "de"
      ? "Der Anbieter hat eine ungültige Streaming-Antwort geliefert. Bitte versuche es erneut."
      : "LLM request failed: provider returned an invalid streaming response. Please try again.";
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    if (locale === "de") {
      return "Die Reihenfolge der Nachrichten ist ungültig. Versuche es erneut oder starte bei anhaltenden Problemen mit /new ein neues Gespräch.";
    }
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (raw && (TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw))) {
    if (locale === "de") {
      return "Der Gesprächsverlauf ist offenbar beschädigt: Die Eingabe eines Werkzeugaufrufs fehlt. Starte mit /new ein neues Gespräch. Setze bei erneutem Auftreten die Sitzung zurück oder lösche den beschädigten Verlauf.";
    }
    return (
      "Session history looks corrupted (tool call input missing). " +
      "Use /new to start a fresh session. " +
      "If this keeps happening, reset the session or delete the corrupted chat history."
    );
  }

  if (providerRuntimeFailureKind === "replay_invalid") {
    if (locale === "de") {
      return "Der Gesprächsverlauf oder sein Wiederherstellungszustand ist ungültig. Starte mit /new ein neues Gespräch und versuche es erneut.";
    }
    return (
      "Session history or replay state is invalid. " +
      "Use /new to start a fresh session and try again."
    );
  }

  const apiError = parseApiErrorInfo(raw);
  if (
    providerRuntimeFailureKind === "schema" &&
    apiError?.type?.toLowerCase().includes("invalid_request") &&
    apiError.message?.trim()
  ) {
    return `LLM request rejected: ${apiError.message.trim()}`;
  }

  if (isGenericProviderInternalError(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  const transportCopy = formatTransportErrorCopy(
    msg.errorCode && isKnownTransportErrorCode(msg.errorCode) ? `${raw} ${msg.errorCode}` : raw,
    locale,
  );
  if (transportCopy) {
    return transportCopy;
  }

  // Provider finished the stream with finish_reason/stop-reason `error` — not a hang.
  // Keep the raw reason in the message so operators still see the provider signal (#109218).
  if (isProviderCompletedErrorFinishReasonMessage(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  if (isTimeoutErrorMessage(raw) && !(facts?.status !== undefined && facts.status >= 500)) {
    return SYNTHESIZED_TIMEOUT_ERROR_TEXT;
  }

  // Full assistant metadata can establish format rejection beyond the raw-text diagnostic.
  if (providerRuntimeFailureKind === "schema" || failoverReason === "format") {
    return formatCopy;
  }

  if (!raw) {
    return failoverReason
      ? renderAssistantRequestFailureCopy(classifiedFacts, locale)
      : locale === "de"
        ? "Die Anfrage an den KI-Dienst ist mit einem unbekannten Fehler fehlgeschlagen."
        : "LLM request failed with an unknown error.";
  }

  if (isRawApiErrorPayload(raw) || isLikelyHttpErrorText(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  if (isStreamingJsonParseError(raw)) {
    return locale === "de"
      ? "Die Streaming-Antwort enthielt einen fehlerhaften Abschnitt. Bitte versuche es erneut."
      : "LLM streaming response contained a malformed fragment. Please try again.";
  }

  // Never return raw unhandled errors - log for debugging but return safe message
  if (raw.length > 600) {
    log.warn(`Long error truncated: ${truncateUtf16Safe(raw, 200)}`);
  }
  return raw.length > 600 ? `${truncateUtf16Safe(raw, 600)}…` : raw;
}

function isRawAssistantErrorPassthrough(params: {
  friendlyError?: string;
  rawError?: string;
}): boolean {
  const friendlyError = params.friendlyError?.trim();
  const rawError = params.rawError?.trim();
  if (!friendlyError || !rawError) {
    return false;
  }
  const parsedMessage = parseApiErrorInfo(rawError)?.message?.trim();
  const leadingStatusRest = extractLeadingHttpStatus(rawError)?.rest?.trim();
  const hasRawDerivedProviderPrefix =
    friendlyError.startsWith("LLM request rejected:") ||
    friendlyError.startsWith("LLM error") ||
    friendlyError.startsWith("HTTP ");
  return (
    (friendlyError === rawError && friendlyError !== SYNTHESIZED_TIMEOUT_ERROR_TEXT) ||
    (rawError.length > 600 && friendlyError === `${truncateUtf16Safe(rawError, 600)}…`) ||
    Boolean(parsedMessage && hasRawDerivedProviderPrefix) ||
    Boolean(leadingStatusRest && friendlyError.startsWith("HTTP "))
  );
}

export function formatUserFacingAssistantErrorText(
  msg: AssistantMessage,
  opts?: AssistantErrorTextOptions,
): string {
  if (msg.errorCode === REPETITIVE_OUTPUT_ERROR_CODE) {
    return REPETITIVE_OUTPUT_ERROR_MESSAGE;
  }
  if (msg.errorCode === REPEATED_TOOL_ERROR_CODE) {
    return readRepeatedToolErrorSummary(msg.errorMessage) ?? REPEATED_TOOL_ERROR_MESSAGE;
  }
  const modelLoadCopy = renderModelLoadFailureCopy(msg);
  if (modelLoadCopy) {
    return modelLoadCopy;
  }
  const rawError = msg.errorMessage?.trim();
  const approvalMessage = resolveExecutionApprovalFailureMessage(rawError);
  if (approvalMessage) {
    return `⚠️ ${approvalMessage}`;
  }
  const facts = classifyAssistantErrorFacts(msg, opts);
  if (!facts.storageFailure && rawError === MODEL_REQUEST_POLICY_DENIED_TEXT) {
    return MODEL_REQUEST_POLICY_DENIED_TEXT;
  }
  const locale = resolveMessageLocale(opts?.locale, opts?.cfg?.messages?.locale);
  const friendlyError = formatAssistantErrorText(msg, opts, facts);
  const rawPassthrough = isRawAssistantErrorPassthrough({ friendlyError, rawError });
  const schemaFriendlyError =
    friendlyError === PROVIDER_SCHEMA_REJECTION_USER_TEXT ||
    friendlyError?.startsWith("LLM request rejected:");
  const schemaFallback =
    locale === "de"
      ? renderAssistantRequestFailureCopy({ reason: "format" }, locale)
      : PROVIDER_SCHEMA_REJECTION_USER_TEXT;
  const safeFriendlyError =
    (schemaFriendlyError
      ? renderAssistantFormatFailureCopy(msg, facts.reason, { locale })
      : undefined) ??
    (rawPassthrough ? (schemaFriendlyError ? schemaFallback : undefined) : friendlyError);
  if (safeFriendlyError) {
    return safeFriendlyError.trim();
  }
  return renderAssistantRequestFailureCopy(facts, locale) ?? GENERIC_ASSISTANT_ERROR_TEXT;
}
