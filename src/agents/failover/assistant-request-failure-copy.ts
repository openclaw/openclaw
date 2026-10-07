import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { escapeMarkdownText } from "../../shared/text/escape-markdown.js";
import { classifyFailoverSignalCore } from "./classify-core.js";
import { isContextOverflowErrorFromTables } from "./context-overflow-tables.js";
import {
  isServerErrorMessage,
  isSessionTranscriptValidationErrorMessage,
  resolveExecutionApprovalFailureMessage,
} from "./message-patterns.js";
import { extractFailoverSignalDetails } from "./signal-details.js";
import type { FailoverReason } from "./signal.js";

export const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
export const PROVIDER_SCHEMA_REJECTION_USER_TEXT =
  "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.";
const GATEWAY_SESSION_TRANSCRIPT_VALIDATION_USER_TEXT =
  "OpenClaw couldn't read this conversation's history. Try /compact, or start a new conversation with /new.";
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

export const ERROR_DETAILS_HINT =
  "For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";

const STORAGE_FAILURE_COPY: Record<GatewayStorageFailure, string> = {
  SQLITE_BUSY:
    "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
  SQLITE_LOCKED:
    "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
  SQLITE_FULL:
    "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
  SQLITE_READONLY:
    "OpenClaw doesn't have permission to save your conversation. Check folder permissions on the computer running OpenClaw.",
  SQLITE_IOERR:
    "OpenClaw couldn't save your conversation. Check the storage on the computer running OpenClaw before continuing.",
  transcript_writer_fenced:
    "This conversation changed while OpenClaw was working. Check its latest messages before continuing.",
};

const RUNTIME_COORDINATION_FAILURE_CODE_COPY: Readonly<Record<string, string>> = {
  codex_node_disconnected: "Codex execution node disconnected. Start a fresh attempt.",
  node_runner_update_required:
    "The device worker requires an update before it can host sessions. Run `openclaw update`, reconnect it, then run `openclaw node restart` on a headless node before trying again.",
  "runner-offline":
    "The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.",
};

const ASSISTANT_REQUEST_FAILURE_COPY = {
  auth: "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
  auth_permanent:
    "The AI service isn't accepting your login. Sign in again under Models in the Control UI or run `openclaw configure`.",
  format: PROVIDER_SCHEMA_REJECTION_USER_TEXT,
  rate_limit: "The AI service needs a short break. Please try again in a few minutes.",
  overloaded: "The AI service is busy. Please try again in a moment, or choose another model.",
  billing:
    "The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.",
  server_error: "The AI service is having trouble. Please try again in a moment.",
  timeout:
    "The request took too long. Check the conversation for any completed work before trying again.",
  tls_certificate: `Couldn't connect securely to the AI service. ${ERROR_DETAILS_HINT}`,
  context_overflow:
    "This conversation is too long for the model. Try /compact, or start a new conversation with /new.",
  model_not_found:
    "This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
  session_expired:
    "Your AI session expired. Start a new conversation with /new. If it happens again, sign in under Models in the Control UI.",
  empty_response: "The AI service returned an empty reply. Please try again.",
  no_error_details: "",
  unclassified: "",
  unknown: "",
} satisfies Record<FailoverReason, string>;

/** Render classified facts without exposing raw provider response text. */
export function renderAssistantRequestFailureCopy(
  facts: AssistantRequestFailureCopyFacts,
): string | undefined {
  if (facts.storageFailure) {
    return `⚠️ ${STORAGE_FAILURE_COPY[facts.storageFailure]} ${ERROR_DETAILS_HINT}`;
  }
  if (facts.code === "incomplete_tool_call") {
    return "⚠️ The task couldn't finish. Some actions may have completed; check their results before continuing.";
  }
  const reason =
    facts.reason === "timeout" && typeof facts.status === "number" && facts.status >= 500
      ? "server_error"
      : facts.reason;
  const copy = reason ? ASSISTANT_REQUEST_FAILURE_COPY[reason] : undefined;
  if (copy) {
    return `⚠️ ${copy}`;
  }
  const hasStatus =
    typeof facts.status === "number" &&
    Number.isInteger(facts.status) &&
    facts.status >= 100 &&
    facts.status <= 599;
  if (!hasStatus && !facts.provider?.trim() && !facts.model?.trim()) {
    return undefined;
  }
  return `⚠️ OpenClaw couldn't finish this reply. ${ERROR_DETAILS_HINT}`;
}

/** Render already-classified coordination facts without loading provider runtime. */
export function renderRuntimeCoordinationFailureCopy(code: string | undefined): string | undefined {
  const copy = code ? RUNTIME_COORDINATION_FAILURE_CODE_COPY[code] : undefined;
  return copy ? `⚠️ ${copy}` : undefined;
}

/** Preserve the rejection diagnostic without publishing the surrounding response body. */
export function renderFormatErrorCopy(raw: string): string {
  const trimmed = raw.trim();
  const normalized =
    extractErrorHttpStatus(trimmed)?.rest ?? trimmed.replace(ERROR_PREFIX_RE, "").trim();
  let candidate = extractErrorHttpStatus(normalized)?.rest ?? normalized;
  // Some proxies serialize the upstream error inside their own error.message.
  for (let depth = 0; depth < 4; depth++) {
    // HTTP reason phrases can precede a body, including inside a proxy's message.
    candidate = (extractErrorHttpStatus(candidate)?.rest ?? candidate).replace(
      /^(?:bad request|unprocessable (?:entity|content))\s*:?\s*(?=[{[<])/iu,
      "",
    );
    const parsedMessage = parseApiErrorInfo(candidate)?.message?.trim();
    if (!parsedMessage || parsedMessage === candidate) {
      break;
    }
    candidate = parsedMessage;
  }
  if (isSessionTranscriptValidationErrorMessage(candidate)) {
    return GATEWAY_SESSION_TRANSCRIPT_VALIDATION_USER_TEXT;
  }
  if (PROVIDER_CACHE_CONTROL_LIMIT_RE.test(candidate)) {
    return "The AI service couldn't accept this conversation. Start a new conversation with /new, or choose another model in the Control UI.";
  }
  if (candidate.length > 300 || !PROVIDER_OUTPUT_TOKEN_LIMIT_RE.test(candidate)) {
    if (!candidate || /^[{<]/u.test(candidate)) {
      return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
    }
    if (candidate.startsWith("[")) {
      try {
        JSON.parse(candidate);
        return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
      } catch {
        // Preserve field-path diagnostics, not truncated or suffixed JSON arrays.
        if (!/^\[[a-z_$][\w$.-]*\](?:\s|:|$)/iu.test(candidate)) {
          return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
        }
      }
    }
    // Redact before truncation so a clipped credential cannot escape matching.
    const detail = redactSensitiveText(candidate, { mode: "tools" })
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
      .trim();
    if (!detail) {
      return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
    }
    const bounded = detail.length > 600 ? `${truncateUtf16Safe(detail, 600)}…` : detail;
    return `LLM request rejected: ${escapeMarkdownText(bounded)}`;
  }
  return "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.";
}

/** Share bounded request-limit facts between live failures and persisted chat history. */
export function renderAssistantFormatFailureCopy(
  message: { errorMessage?: unknown; errorBody?: unknown; errorType?: unknown },
  reason?: FailoverReason | null,
): string | undefined {
  for (const [isBody, raw] of [
    [true, message.errorBody],
    [false, message.errorMessage],
  ] as const) {
    if (typeof raw !== "string") {
      continue;
    }
    const info = parseApiErrorInfo(raw);
    if (isBody && !info?.message) {
      continue;
    }
    const status = extractErrorHttpStatus(raw)?.code;
    if (
      reason !== "format" &&
      !(
        typeof message.errorType === "string" &&
        message.errorType.toLowerCase().includes("invalid_request")
      ) &&
      !info?.type?.toLowerCase().includes("invalid_request") &&
      status !== 400 &&
      status !== 422
    ) {
      continue;
    }
    const copy = renderFormatErrorCopy(raw);
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
  const approvalMessage = resolveExecutionApprovalFailureMessage(
    typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  );
  if (approvalMessage) {
    return `⚠️ ${approvalMessage}`;
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
    return "This conversation is too long for the model. Try /compact, or start a new conversation with /new.";
  }
  const formatCopy =
    !classification?.reason || classification.reason === "format"
      ? renderAssistantFormatFailureCopy(message, classification?.reason)
      : undefined;
  if (formatCopy) {
    return formatCopy;
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
