import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  boundedJsonUtf8Bytes,
  firstEnumerableOwnKeys,
  jsonUtf8BytesOrInfinity,
  type BoundedJsonUtf8Bytes,
} from "../infra/json-utf8-bytes.js";
import {
  isSensitiveFieldKey,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";
import { formatContextLimitTruncationNotice } from "./embedded-agent-runner/context-truncation-notice.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  truncateToolResultMessage,
} from "./embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "./runtime/index.js";

export function resolveMaxToolResultChars(opts?: { maxToolResultChars?: number }): number {
  return resolveIntegerOption(opts?.maxToolResultChars, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS, {
    min: 1,
  });
}

// `details` is runtime/UI metadata, not model-visible tool output. Keep the
// session JSONL useful for debugging without letting metadata blobs dominate
// disk, replay repair, transcript broadcasts, or future tooling that reads raw
// sessions. Model-visible text belongs in tool result `content`.
const MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES = 8_192;
const MAX_PERSISTED_DETAIL_STRING_CHARS = 2_000;
const MAX_PERSISTED_DETAIL_SESSION_COUNT = 10;
const MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS = 200;
const MAX_PERSISTED_DETAIL_REDACTION_LOOKAHEAD_CHARS = 1_024;
const MAX_PERSISTED_DETAIL_BOUNDARY_OVERLAP_CHARS = 512;
const PERSISTED_DETAIL_REDACTION_BOUNDARY = "\u0000OPENCLAW_PERSISTED_DETAIL_BOUNDARY\u0000";
const PARTIAL_STRUCTURED_SECRET_VALUE_RE =
  /(?:["']?(?:api[-_]?key|apikey|token|secret|password|passwd|access[-_]?token|accesstoken|refresh[-_]?token|refreshtoken|auth[-_]?token|authtoken|client[-_]?secret|clientsecret|app[-_]?secret|appsecret|card[-_]?number|cardnumber|cvc|cvv)["']?\s*[:=]\s*["']?)(?!\*{3})(?=[^\s"',}\]]{8,})/i;
const PARTIAL_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY)-----/i;

type ToolResultDetailRedactionConfig = Parameters<typeof redactToolPayloadTextWithConfig>[1];
function originalDetailsSizeFields(size: BoundedJsonUtf8Bytes): Record<string, number> {
  return size.complete
    ? { originalDetailsBytes: size.bytes }
    : { originalDetailsBytesAtLeast: size.bytes };
}

function redactPersistedDetailString(
  value: string,
  maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS,
  redactionConfig?: ToolResultDetailRedactionConfig,
): string {
  if (value.length <= maxChars) {
    return redactToolPayloadTextWithConfig(value, redactionConfig);
  }

  const scan = `${sliceUtf16Safe(value, 0, maxChars)}${PERSISTED_DETAIL_REDACTION_BOUNDARY}${sliceUtf16Safe(
    value,
    maxChars,
    maxChars + MAX_PERSISTED_DETAIL_REDACTION_LOOKAHEAD_CHARS,
  )}`;
  const redactedScan = redactToolPayloadTextWithConfig(scan, redactionConfig);
  const boundaryIndex = redactedScan.indexOf(PERSISTED_DETAIL_REDACTION_BOUNDARY);
  const redactedPrefix =
    boundaryIndex >= 0
      ? redactedScan.slice(0, boundaryIndex)
      : "[OpenClaw persisted detail redacted: boundary marker removed]";
  const safePrefixChars = Math.max(
    0,
    maxChars - Math.min(maxChars, MAX_PERSISTED_DETAIL_BOUNDARY_OVERLAP_CHARS),
  );
  const initialPersistedPrefix = truncateUtf16Safe(redactedPrefix, safePrefixChars);
  const persistedPrefix =
    PARTIAL_STRUCTURED_SECRET_VALUE_RE.test(initialPersistedPrefix) ||
    PARTIAL_PRIVATE_KEY_BLOCK_RE.test(initialPersistedPrefix)
      ? "[OpenClaw persisted detail redacted: partial secret span omitted]"
      : initialPersistedPrefix;
  const boundaryNotice = "[OpenClaw persisted detail redacted: boundary overlap omitted]";
  return `${persistedPrefix}${persistedPrefix ? "\n" : ""}${boundaryNotice}\n\n[OpenClaw persisted detail truncated: ${Math.max(
    0,
    value.length - maxChars,
  )} original chars omitted]`;
}

function selectPersistedDetailRedactionKey(
  key: string,
  inheritedKey: string | undefined,
): string | undefined {
  return isSensitiveFieldKey(key) ? key : inheritedKey;
}

function redactedOriginalDetailKeys(
  src: Record<string, unknown>,
  redactionConfig?: ToolResultDetailRedactionConfig,
): string[] {
  return firstEnumerableOwnKeys(src, 40).map((key) =>
    redactToolPayloadTextWithConfig(key, redactionConfig),
  );
}

function redactPersistedDetailValue(
  value: unknown,
  depth = 0,
  redactionKey?: string,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (typeof value === "string") {
    return redactionKey
      ? redactSensitiveFieldValueWithConfig(redactionKey, value, redactionConfig)
      : redactToolPayloadTextWithConfig(value, redactionConfig);
  }
  if (
    redactionKey &&
    (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
  ) {
    return redactSensitiveFieldValueWithConfig(redactionKey, String(value), redactionConfig);
  }
  const source = asOptionalObjectRecord(value);
  if (!source) {
    return value;
  }
  if (depth >= 8) {
    return "[OpenClaw persisted detail redacted: max depth exceeded]";
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactPersistedDetailValue(item, depth + 1, redactionKey, redactionConfig);
      changed ||= redacted !== item;
      return redacted;
    });
    return changed ? next : value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(source)) {
    const redactedKey = redactToolPayloadTextWithConfig(key, redactionConfig);
    const redacted = redactPersistedDetailValue(
      field,
      depth + 1,
      selectPersistedDetailRedactionKey(key, redactionKey),
      redactionConfig,
    );
    changed ||= redactedKey !== key || redacted !== field;
    next[redactedKey] = redacted;
  }
  return changed ? next : value;
}

function redactPersistedSummaryField(
  key: string,
  value: unknown,
  maxStringChars: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (typeof value === "string") {
    return redactPersistedDetailString(value, maxStringChars, redactionConfig);
  }
  return redactPersistedDetailValue(
    value,
    0,
    selectPersistedDetailRedactionKey(key, undefined),
    redactionConfig,
  );
}

function copyPersistedSummaryFields(params: {
  target: Record<string, unknown>;
  source: Record<string, unknown>;
  keys: readonly string[];
  maxChars: number;
  redactionConfig?: ToolResultDetailRedactionConfig;
}): void {
  for (const key of params.keys) {
    const value = params.source[key];
    if (value !== undefined) {
      params.target[key] = redactPersistedSummaryField(
        key,
        value,
        params.maxChars,
        params.redactionConfig,
      );
    }
  }
}

function sanitizePersistedSessionDetail(
  value: unknown,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  const src = asOptionalObjectRecord(value);
  if (!src) {
    return value;
  }
  const out: Record<string, unknown> = {};
  copyPersistedSummaryFields({
    target: out,
    source: src,
    keys: [
      "sessionId",
      "status",
      "pid",
      "startedAt",
      "endedAt",
      "runtimeMs",
      "cwd",
      "name",
      "truncated",
      "exitCode",
      "exitSignal",
    ],
    maxChars: 500,
    redactionConfig,
  });
  if (typeof src.command === "string") {
    out.command = redactPersistedDetailString(src.command, 500, redactionConfig);
  }
  return out;
}

function copyPersistedResultStateFields(
  out: Record<string, unknown>,
  src: Record<string, unknown>,
  maxStringChars: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): void {
  for (const key of ["disabled", "unavailable", "success"] as const) {
    if (typeof src[key] === "boolean") {
      out[key] = src[key];
    }
  }
  if (typeof src.error === "string" && src.error) {
    out.error = redactPersistedDetailString(src.error, maxStringChars, redactionConfig);
  } else if (src.error) {
    out.error = true;
  }
}

function buildPersistedDetailsFallback(
  src: Record<string, unknown> | undefined,
  originalSize: BoundedJsonUtf8Bytes,
  sanitizedBytes?: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): Record<string, unknown> {
  // If even the structured summary is too large, keep only shape and stable
  // status fields. This preserves "what happened?" without persisting the raw
  // diagnostics payload that caused the cap to trip.
  const fallback: Record<string, unknown> = {
    persistedDetailsTruncated: true,
    finalDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
  };
  if (sanitizedBytes !== undefined) {
    fallback.sanitizedDetailsBytes = sanitizedBytes;
  }
  if (src) {
    fallback.originalDetailKeys = redactedOriginalDetailKeys(src, redactionConfig);
    copyPersistedSummaryFields({
      target: fallback,
      source: src,
      keys: [
        "status",
        "sessionId",
        "pid",
        "exitCode",
        "exitSignal",
        "truncated",
        "spill",
        "fullOutputPath",
        "spilledChars",
        "spillTruncated",
      ],
      maxChars: MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS,
      redactionConfig,
    });
    copyPersistedResultStateFields(
      fallback,
      src,
      MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS,
      redactionConfig,
    );
  }
  return fallback;
}

function enforcePersistedDetailsByteCap(
  value: unknown,
  originalDetails: unknown,
  originalSize: BoundedJsonUtf8Bytes,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
  if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return value;
  }
  const fallback = buildPersistedDetailsFallback(
    isRecord(originalDetails) ? originalDetails : undefined,
    originalSize,
    sanitizedBytes,
    redactionConfig,
  );
  return jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES
    ? fallback
    : buildPersistedDetailsFallback(undefined, originalSize, sanitizedBytes);
}

function sanitizeToolResultDetailsForPersistence(
  details: unknown,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (details === undefined || details === null) {
    return details;
  }
  // Measure with an early-exit walker so hostile or enormous details do not
  // need to be fully stringified just to learn they exceed the persistence cap.
  const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
  if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return enforcePersistedDetailsByteCap(
      redactPersistedDetailValue(details, 0, undefined, redactionConfig),
      details,
      originalSize,
      redactionConfig,
    );
  }
  const src = asOptionalObjectRecord(details);
  if (!src) {
    return enforcePersistedDetailsByteCap(
      {
        persistedDetailsTruncated: true,
        ...originalDetailsSizeFields(originalSize),
        valueType: typeof details,
      },
      undefined,
      originalSize,
      redactionConfig,
    );
  }
  const out: Record<string, unknown> = {
    persistedDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
    originalDetailKeys: redactedOriginalDetailKeys(src, redactionConfig),
  };
  copyPersistedSummaryFields({
    target: out,
    source: src,
    keys: [
      "status",
      "sessionId",
      "pid",
      "startedAt",
      "endedAt",
      "cwd",
      "name",
      "exitCode",
      "exitSignal",
      "retryInMs",
      "total",
      "totalLines",
      "totalChars",
      "truncated",
      "spill",
      "fullOutputPath",
      "spilledChars",
      "spillTruncated",
      "truncation",
    ],
    maxChars: MAX_PERSISTED_DETAIL_STRING_CHARS,
    redactionConfig,
  });
  copyPersistedResultStateFields(out, src, MAX_PERSISTED_DETAIL_STRING_CHARS, redactionConfig);
  if (typeof src.tail === "string") {
    out.tail = redactPersistedDetailString(
      src.tail,
      MAX_PERSISTED_DETAIL_STRING_CHARS,
      redactionConfig,
    );
  }
  if (Array.isArray(src.sessions)) {
    out.sessions = src.sessions
      .slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT)
      .map((session) => sanitizePersistedSessionDetail(session, redactionConfig));
    if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) {
      out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
    }
  }
  return enforcePersistedDetailsByteCap(out, src, originalSize, redactionConfig);
}

export function capToolResultForPersistence(
  msg: AgentMessage,
  maxChars: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): AgentMessage {
  const capped =
    msg.role === "toolResult"
      ? truncateToolResultMessage(msg, maxChars, {
          suffix: formatContextLimitTruncationNotice,
          minKeepChars: 2_000,
        })
      : msg;
  if (capped.role !== "toolResult") {
    return capped;
  }
  const details = capped.details;
  const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details, redactionConfig);
  return sanitizedDetails === details ? capped : { ...capped, details: sanitizedDetails };
}

export function normalizePersistedToolResultName(
  message: AgentMessage,
  fallbackName?: string,
  fallbackId?: string,
): AgentMessage {
  if (message.role !== "toolResult") {
    return message;
  }
  const rawToolName = message.toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  const normalizedFallback = normalizeOptionalString(fallbackName);
  const toolName = normalizedToolName ?? normalizedFallback ?? "unknown";
  const rawToolCallIdValue = message.toolCallId;
  const rawToolCallId = typeof rawToolCallIdValue === "string" ? rawToolCallIdValue : undefined;
  const toolCallId = rawToolCallId ?? normalizeOptionalString(fallbackId);
  const isError = typeof message.isError === "boolean" ? message.isError : false;
  if (rawToolName === toolName && rawToolCallId === toolCallId && message.isError === isError) {
    return message;
  }
  return {
    ...message,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
    isError,
  };
}
