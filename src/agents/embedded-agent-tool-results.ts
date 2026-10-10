/** Sanitizes, extracts, and classifies embedded-agent tool execution results. */
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  redactModelVisibleSecrets,
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadText,
  redactSensitiveFieldValue,
  redactToolPayloadText,
} from "../logging/redact.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { createToolResultPreparation } from "./embedded-agent-tool-result-preparation.js";
import {
  isToolResultError,
  readToolResultDetails,
  readToolResultStatus,
} from "./tool-result-error.js";

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;
const LIVE_EXEC_OUTPUT_MAX_CHARS = 8000;
const TOOL_DENIAL_ERROR_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;
const OPAQUE_STRUCTURED_RESULT_FIELDS = new Set(["encrypted_content", "encrypted_stdout"]);
const SENSITIVE_STRUCTURED_HEADER_FIELDS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

/** Recognize work accepted by a tool whose background task owns completion. */
export function isAsyncStartedToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  return details?.async === true && details.status === "started";
}

/** Preserve the accepted task's identity independently of result presentation. */
export function readAsyncStartedTaskIds(result: unknown): {
  asyncTaskRunId?: string;
  asyncTaskId?: string;
} {
  const details = readToolResultDetails(result);
  if (!details) {
    return {};
  }
  const nestedTask = readRecord(details.task);
  const asyncTaskRunId = readStringValue(details.runId) ?? readStringValue(nestedTask?.runId);
  const asyncTaskId = readStringValue(details.taskId) ?? readStringValue(nestedTask?.taskId);
  return {
    ...(asyncTaskRunId ? { asyncTaskRunId } : {}),
    ...(asyncTaskId ? { asyncTaskId } : {}),
  };
}

function truncateToolText(
  text: string,
  maxChars = TOOL_RESULT_MAX_CHARS,
  suffix = "\n…(truncated)…",
): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${truncateUtf16Safe(text, maxChars)}${suffix}`;
}

export function truncateLiveExecOutput(text: string): string {
  return truncateToolText(text, LIVE_EXEC_OUTPUT_MAX_CHARS, "\n...(live output truncated)...");
}

export function capLiveExecResult(result: unknown): unknown {
  const details = readToolResultDetails(result);
  if (!details || typeof details.status !== "string" || typeof details.aggregated !== "string") {
    return result;
  }
  const aggregated = truncateLiveExecOutput(details.aggregated);
  if (aggregated === details.aggregated) {
    return result;
  }
  if (Array.isArray(result)) {
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    details: {
      ...details,
      aggregated,
    },
  };
}

function normalizeToolErrorText(text: string): string | undefined {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }
  return truncateToolText(firstLine, TOOL_ERROR_MAX_CHARS, "…");
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  const record = asOptionalObjectRecord(value);
  if (typeof record?.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record?.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = extractDirectErrorField(record);
  if (direct) {
    return direct;
  }
  const status = normalizeOptionalString(record.status);
  return status &&
    /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(status.toLowerCase())
    ? normalizeToolErrorText(status)
    : undefined;
}

function extractDirectErrorField(value: unknown): string | undefined {
  const record = asOptionalObjectRecord(value);
  return (
    readErrorCandidate(record?.error) ??
    readErrorCandidate(record?.message) ??
    readErrorCandidate(record?.reason)
  );
}

function readDenialErrorCodeFromMessage(value: unknown): string | undefined {
  const message = normalizeOptionalString(value);
  if (!message) {
    return undefined;
  }
  return TOOL_DENIAL_ERROR_CODES.find((code) => message === code || message.startsWith(`${code}:`));
}

function readNestedErrorCodeField(value: unknown): string | undefined {
  const record = asOptionalObjectRecord(value);
  return (
    readDenialErrorCodeFromMessage(record?.message) ??
    readDenialErrorCodeFromMessage(record?.error) ??
    normalizeOptionalString(record?.code) ??
    normalizeOptionalString(record?.gatewayCode)
  );
}

function extractDirectErrorCodeField(value: unknown): string | undefined {
  const record = asOptionalObjectRecord(value);
  return (
    readNestedErrorCodeField(record?.error) ??
    readNestedErrorCodeField(record?.nodeError) ??
    normalizeOptionalString(record?.code) ??
    normalizeOptionalString(record?.gatewayCode)
  );
}

export function buildToolLifecycleErrorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const errorRecord = readRecord(error);
  const rawDetails = readRecord(errorRecord?.details);
  const nodeError = readRecord(rawDetails?.nodeError);
  const gatewayCode =
    normalizeOptionalString(errorRecord?.gatewayCode) ?? normalizeOptionalString(errorRecord?.code);
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "error",
      error: message,
      ...(gatewayCode ? { gatewayCode } : {}),
      ...(nodeError ? { nodeError } : {}),
    },
  };
}

export function sanitizeToolArgs(args: unknown): unknown {
  return redactToolPayloadValue(args, "args");
}

/** A string result keeps its string type: only model-visible redaction is applied to it. */
export function sanitizeToolResult(result: string): string;
export function sanitizeToolResult(result: unknown): unknown;
export function sanitizeToolResult(result: unknown): unknown {
  if (typeof result === "string") {
    return redactModelVisibleToolPayloadText(result);
  }
  if (!result || typeof result !== "object") {
    return result;
  }
  return sanitizeStructuredToolResult(result);
}

export function prepareToolResult(result: unknown): () => unknown {
  return result && typeof result === "object"
    ? createToolResultPreparation(result, () => sanitizeStructuredToolResult(result))
    : () => sanitizeToolResult(result);
}

function sanitizeStructuredToolResult(result: object): object {
  if (Array.isArray(result)) {
    return redactModelVisibleSecrets(result);
  }
  const record = result as Record<string, unknown>;
  // Strip image data first so the deep redaction pass doesn't waste work
  // scanning base64 payloads (and so we capture the original byte counts).
  const preCleaned: Record<string, unknown> = { ...record };
  const originalContent = Array.isArray(record.content) ? record.content : null;
  if (originalContent) {
    preCleaned.content = originalContent.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const entry = item as Record<string, unknown>;
      if (readStringValue(entry.type) === "image") {
        const data = readStringValue(entry.data);
        const existingBytes = typeof entry.bytes === "number" ? entry.bytes : undefined;
        const bytes = data === undefined ? existingBytes : estimateBase64DecodedBytes(data);
        const cleaned = { ...entry };
        delete cleaned.data;
        return Object.assign(cleaned, { bytes, omitted: true });
      }
      return entry;
    });
  }
  // Deep-redact the entire result so any top-level or nested string is
  // protected, not just `details` and text content blocks.
  const out = redactModelVisibleSecrets(preCleaned);
  const content = Array.isArray(out.content) ? out.content : null;
  if (content) {
    out.content = content.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const entry = item as Record<string, unknown>;
      if (readStringValue(entry.type) === "text" && typeof entry.text === "string") {
        const text = truncateToolText(entry.text);
        // Nonplain blocks can still be caller-owned; spread keeps JSON keys as own data.
        return Object.assign({ ...entry }, { text });
      }
      return entry;
    });
  }
  return out;
}

const INLINE_DATA_URI_VALUE_PATTERN =
  /^data:(?:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+)?(?:;[a-z0-9.+-]+(?:=[^,;"'\s]+)?)*,/i;

function redactInlineDataUriValue(value: string): string {
  const trimmed = value.trimStart();
  if (!INLINE_DATA_URI_VALUE_PATTERN.test(trimmed)) {
    return value;
  }
  return `[inline data URI: ${value.length} chars]`;
}

function carriesBinaryData(record: Record<string, unknown>): boolean {
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "audio" || type === "image" || type === "base64") {
    return true;
  }
  const mediaType = normalizeOptionalLowercaseString(record.media_type ?? record.mimeType);
  return (
    mediaType?.startsWith("image/") === true ||
    mediaType?.startsWith("audio/") === true ||
    mediaType?.startsWith("video/") === true ||
    mediaType === "application/pdf"
  );
}

function redactToolPayloadValue(
  value: unknown,
  mode: "args" | "result",
  key?: string,
  parentCarriesBinaryData = false,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    if (mode === "args") {
      return key === undefined
        ? redactToolPayloadText(value)
        : redactSensitiveFieldValue(key, value);
    }
    const field = key ?? "";
    if (SENSITIVE_STRUCTURED_HEADER_FIELDS.has(field.toLowerCase())) {
      return "***";
    }
    if (field === "blob" || (field === "data" && parentCarriesBinaryData)) {
      return `[binary omitted: ${value.length} chars]`;
    }
    // Claude CLI result blocks carry replay-only ciphertext that is not useful display text.
    if (OPAQUE_STRUCTURED_RESULT_FIELDS.has(field)) {
      return `[opaque data omitted: ${value.length} chars]`;
    }
    return truncateToolText(
      redactInlineDataUriValue(redactModelVisibleSensitiveFieldValueWithConfig(field, value)),
    );
  }
  if (mode === "result" && typeof value === "bigint") {
    return value.toString();
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    // Structured results retain credential keys through arrays; argument arrays
    // use the same free-text policy as root argument strings.
    const arrayKey = mode === "result" ? key : undefined;
    return value.map((item) =>
      redactToolPayloadValue(item, mode, arrayKey, parentCarriesBinaryData, seen),
    );
  }
  const record = value as Record<string, unknown>;
  const hasBinaryData = mode === "result" && carriesBinaryData(record);
  return Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => [
      childKey,
      redactToolPayloadValue(child, mode, childKey, hasBinaryData, seen),
    ]),
  );
}

function stringifyStructuredToolResultContent(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  const type = readStringValue(record.type);
  if (type === "text" || type === "image" || type === "image_url" || type === "audio") {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(redactToolPayloadValue(record, "result"));
    const redacted = serialized ? redactModelVisibleToolPayloadText(serialized) : serialized;
    return redacted && redacted !== "{}" ? redacted : undefined;
  } catch {
    return undefined;
  }
}

function resolveToolResultContentBlocks(result: object): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  // Typed provider blocks own their `content`; only untyped tool-result envelopes unwrap it.
  if (readStringValue(record.type)) {
    return [record];
  }
  if (Array.isArray(record.content)) {
    return record.content;
  }
  if (record.content && typeof record.content === "object") {
    return [record.content];
  }
  return [record];
}

export function extractToolResultText(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = redactModelVisibleToolPayloadText(redactInlineDataUriValue(result)).trim();
    return trimmed ? truncateToolText(trimmed) : undefined;
  }
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const content = resolveToolResultContentBlocks(result);
  const texts = collectTextContentBlocks(content)
    .map((item) => item.trim())
    .filter(Boolean);
  const selected =
    texts.length > 0 ? texts : content.map(stringifyStructuredToolResultContent).filter(Boolean);
  return selected.length > 0 ? truncateToolText(selected.join("\n")) : undefined;
}

export function extractToolErrorCode(result: unknown): string | undefined {
  const record = asOptionalObjectRecord(result);
  return extractDirectErrorCodeField(record?.details) ?? extractDirectErrorCodeField(record);
}

export function isToolResultTimedOut(result: unknown): boolean {
  return (
    readToolResultStatus(result) === "timeout" || readToolResultDetails(result)?.timedOut === true
  );
}

export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const direct =
    extractDirectErrorField(record.details) ??
    readErrorCandidate(asOptionalObjectRecord(record.details)?.aggregated) ??
    extractDirectErrorField(record);
  if (direct) {
    return direct;
  }
  const text = extractToolResultText(result);
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const fromJson = extractErrorField(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // Fall through to status/text fallback.
    }
  }
  const fromStatus = extractErrorField(record.details) ?? extractErrorField(record);
  if (fromStatus) {
    return fromStatus;
  }
  const status = readToolResultStatus(result);
  if (status && !isToolResultError(result)) {
    return undefined;
  }
  return text ? normalizeToolErrorText(text) : undefined;
}
