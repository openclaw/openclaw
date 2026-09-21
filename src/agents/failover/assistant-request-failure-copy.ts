import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { classifyFailoverSignalCore } from "./classify-core.js";
import { isContextOverflowErrorFromTables } from "./context-overflow-tables.js";
import {
  isServerErrorMessage,
  isSessionTranscriptValidationErrorMessage,
} from "./message-patterns.js";
import { extractFailoverSignalDetails } from "./signal-details.js";
import type { FailoverReason } from "./signal.js";

export const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
export const PROVIDER_SCHEMA_REJECTION_USER_TEXT =
  "LLM request failed: provider rejected the request schema or tool payload.";
const GATEWAY_SESSION_TRANSCRIPT_VALIDATION_USER_TEXT =
  "LLM request failed: the Gateway rejected a session transcript entry. Compact or reset this session and try again.";
const PROVIDER_OUTPUT_TOKEN_LIMIT_RE =
  /^['"]?max_(?:tokens|output_tokens|completion_tokens|new_tokens)['"]?\s*(?:[:=]\s*)?\(?(\d[\d,]*)\)?\s+exceeds?\b.{0,120}?\b(?:maximum|max|limit)\b(?:\s+(?:output\s+)?tokens?)?(?:\s+(?:is|of)|\s*[:=])?\s*\(?(\d[\d,]*)\)?(?:\D|$)/i;
const PROVIDER_CACHE_CONTROL_LIMIT_RE =
  /^A maximum of (\d{1,6}) blocks with cache_control may be provided\. Found (\d{1,6})\.$/i;

type AssistantRequestFailureCopyFacts = {
  provider?: string;
  model?: string;
  reason?: FailoverReason | null;
  status?: number;
  storageFailure?: GatewayStorageFailure;
  code?: string;
};

const STORAGE_FAILURE_COPY: Record<GatewayStorageFailure, string> = {
  SQLITE_BUSY:
    "the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
  SQLITE_LOCKED:
    "the Gateway state database was locked (SQLite: database table is locked). Retry; if it repeats, check Gateway storage health.",
  SQLITE_FULL:
    "the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
  SQLITE_READONLY:
    "the Gateway state database was read-only (SQLite: attempt to write a readonly database). Check Gateway storage permissions and retry.",
  SQLITE_IOERR:
    "the Gateway state database had an I/O error (SQLite: disk I/O error). Check Gateway storage health and filesystem access before retrying.",
  transcript_writer_fenced:
    "the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.",
};

const ASSISTANT_REQUEST_FAILURE_REASON = {
  auth: "authentication failed",
  auth_permanent: "authentication was rejected",
  format: "request format rejected",
  rate_limit: "rate limited",
  overloaded: "provider overloaded",
  billing: "provider billing issue",
  server_error: "provider internal error",
  timeout: "request timed out",
  tls_certificate: "TLS certificate error",
  context_overflow: "context limit exceeded",
  model_not_found: "model not found",
  session_expired: "provider session expired",
  empty_response: "",
  no_error_details: "",
  unclassified: "",
  unknown: "",
} satisfies Record<FailoverReason, string>;

/** Render classified facts without exposing raw provider response text. */
export function renderAssistantRequestFailureCopy(
  facts: AssistantRequestFailureCopyFacts,
): string | undefined {
  if (facts.storageFailure) {
    return `⚠️ Agent run failed: ${STORAGE_FAILURE_COPY[facts.storageFailure]}`;
  }
  if (facts.code === "incomplete_tool_call") {
    return "⚠️ The provider returned an unfinished tool call. Earlier actions may have completed; verify their results before continuing.";
  }
  const provider = facts.provider?.trim();
  const model = facts.model?.trim();
  const target = provider && model ? `${provider}/${model}` : provider || model;
  const normalizedReason =
    facts.reason === "timeout" && typeof facts.status === "number" && facts.status >= 500
      ? "server_error"
      : facts.reason;
  const reason = normalizedReason ? ASSISTANT_REQUEST_FAILURE_REASON[normalizedReason] : undefined;
  const httpStatus = facts.status;
  const status =
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? `HTTP ${httpStatus}`
      : undefined;
  // A recognized provider terminal can have no displayable reason.
  const unclassified =
    !facts.reason || facts.reason === "unclassified" || facts.reason === "unknown";
  if (!reason && !status && (!target || unclassified)) {
    return target ? `⚠️ Agent run failed (${model ? "model" : "provider"}: ${target}).` : undefined;
  }
  const details = [reason, status].filter(Boolean);
  const summary = `⚠️ ${target ? `${target} request failed` : "LLM request failed"}${details.length > 0 ? ` (${details.join(", ")})` : ""}.`;
  if (
    normalizedReason === "overloaded" ||
    normalizedReason === "server_error" ||
    normalizedReason === "timeout" ||
    normalizedReason === "rate_limit"
  ) {
    return `${summary} This is usually temporary — try again shortly.`;
  }
  if (facts.reason === "auth" || facts.reason === "auth_permanent") {
    return `${summary} Re-authenticate the provider and try again.`;
  }
  if (facts.reason === "billing") {
    return `${summary} Check ${provider ? `${provider} billing` : "provider billing"} and try again.`;
  }
  return summary;
}

/** Surface bounded rejection facts without arbitrary provider-controlled text. */
export function renderFormatErrorCopy(raw: string): string {
  const trimmed = raw.trim();
  const normalized =
    extractErrorHttpStatus(trimmed)?.rest ?? trimmed.replace(ERROR_PREFIX_RE, "").trim();
  const candidate = extractErrorHttpStatus(normalized)?.rest ?? normalized;
  if (isSessionTranscriptValidationErrorMessage(candidate)) {
    return GATEWAY_SESSION_TRANSCRIPT_VALIDATION_USER_TEXT;
  }
  const cacheLimit = candidate.match(PROVIDER_CACHE_CONTROL_LIMIT_RE);
  if (cacheLimit) {
    return `LLM request rejected: provider allows at most ${cacheLimit[1]} cache_control blocks; the request contained ${cacheLimit[2]}.`;
  }
  const match = candidate.length <= 300 ? candidate.match(PROVIDER_OUTPUT_TOKEN_LIMIT_RE) : null;
  const [, value, maximum] = match ?? [];
  if (!value || !maximum) {
    return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
  }
  return `LLM request rejected: configured maxTokens is ${value}, above the provider maximum of ${maximum}. Lower maxTokens and try again.`;
}

/** Share bounded request-limit facts between live failures and persisted chat history. */
export function renderAssistantFormatFailureCopy(message: {
  errorMessage?: unknown;
  errorBody?: unknown;
}): string | undefined {
  for (const raw of [message.errorMessage, message.errorBody]) {
    if (typeof raw !== "string") {
      continue;
    }
    const info = parseApiErrorInfo(raw);
    const status = extractErrorHttpStatus(raw)?.code;
    if (
      !info?.type?.toLowerCase().includes("invalid_request") &&
      status !== 400 &&
      status !== 422
    ) {
      continue;
    }
    const copy = renderFormatErrorCopy(info?.message ?? raw);
    if (copy !== PROVIDER_SCHEMA_REJECTION_USER_TEXT) {
      return copy;
    }
  }
  return undefined;
}

/** Classify saved error facts without loading providers or publishing their raw diagnostics. */
export function renderRecordedAssistantFailureCopy(message: {
  errorMessage?: unknown;
  errorBody?: unknown;
  errorCode?: unknown;
  errorType?: unknown;
}): string | undefined {
  const formatCopy = renderAssistantFormatFailureCopy(message);
  if (formatCopy) {
    return formatCopy;
  }
  const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (raw === "Worker inference result exceeds the transcript message limit.") {
    return "The worker could not save the model response because it exceeded the message size limit. Retry with a smaller response or continue on the Gateway. Earlier actions may have completed; verify their results before continuing.";
  }
  if (
    raw ===
    "Cloud worker could not preserve authoritative provider replay. Stop or reclaim the cloud worker, then retry locally."
  ) {
    return "The worker could not preserve the model's continuation data. Stop or reclaim the worker, then retry on the Gateway. Earlier actions may have completed; verify their results before continuing.";
  }
  const info = parseApiErrorInfo(raw);
  const code = typeof message.errorCode === "string" ? message.errorCode : info?.code;
  const status = extractErrorHttpStatus(raw)?.code;
  const classification = classifyFailoverSignalCore({
    message: raw,
    code,
    errorType: typeof message.errorType === "string" ? message.errorType : info?.type,
    status,
    details: extractFailoverSignalDetails(message.errorBody),
  });
  if (
    classification?.kind === "context_overflow" ||
    [message.errorCode, message.errorType, raw].some(
      (value) =>
        typeof value === "string" &&
        (normalizeLowercaseStringOrEmpty(value) === "context_overflow" ||
          isContextOverflowErrorFromTables(value)),
    )
  ) {
    return "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";
  }
  const classifiedCopy = renderAssistantRequestFailureCopy({
    code,
    status,
    // The legacy timeout retry bucket also includes explicit server failures.
    reason:
      classification?.reason === "timeout" && isServerErrorMessage(raw)
        ? "server_error"
        : classification?.reason,
  });
  if (status !== undefined || (classification && classification.reason !== "timeout")) {
    return classifiedCopy;
  }
  return formatTransportErrorCopy([raw, code].filter(Boolean).join(" ")) ?? classifiedCopy;
}
