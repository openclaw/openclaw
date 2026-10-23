import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  boundedJsonUtf8Bytes,
  firstEnumerableOwnKeys,
  jsonUtf8BytesOrInfinity,
  type BoundedJsonUtf8Bytes,
} from "../infra/json-utf8-bytes.js";
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
function originalDetailsSizeFields(size: BoundedJsonUtf8Bytes): Record<string, number> {
  return size.complete
    ? { originalDetailsBytes: size.bytes }
    : { originalDetailsBytesAtLeast: size.bytes };
}

function truncatePersistedDetailString(
  value: string,
  maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS,
): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${truncateUtf16Safe(value, maxChars)}\n\n[OpenClaw persisted detail truncated: ${value.length - maxChars} original chars omitted]`;
}

function copyPersistedSummaryFields(params: {
  target: Record<string, unknown>;
  source: Record<string, unknown>;
  keys: readonly string[];
  maxChars: number;
}): void {
  for (const key of params.keys) {
    const value = params.source[key];
    if (value !== undefined) {
      params.target[key] =
        typeof value === "string" ? truncatePersistedDetailString(value, params.maxChars) : value;
    }
  }
}

function sanitizePersistedSessionDetail(value: unknown): unknown {
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
  });
  if (typeof src.command === "string") {
    out.command = truncatePersistedDetailString(src.command, 500);
  }
  return out;
}

function copyPersistedResultStateFields(
  out: Record<string, unknown>,
  src: Record<string, unknown>,
  maxStringChars: number,
): void {
  for (const key of ["disabled", "unavailable", "success"] as const) {
    if (typeof src[key] === "boolean") {
      out[key] = src[key];
    }
  }
  if (typeof src.error === "string" && src.error) {
    out.error = truncatePersistedDetailString(src.error, maxStringChars);
  } else if (src.error) {
    out.error = true;
  }
}

function buildPersistedDetailsFallback(
  src: Record<string, unknown> | undefined,
  originalSize: BoundedJsonUtf8Bytes,
  sanitizedBytes?: number,
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
    fallback.originalDetailKeys = firstEnumerableOwnKeys(src, 40);
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
    });
    copyPersistedResultStateFields(fallback, src, MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS);
  }
  return fallback;
}

function enforcePersistedDetailsByteCap(
  value: unknown,
  originalDetails: unknown,
  originalSize: BoundedJsonUtf8Bytes,
): unknown {
  const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
  if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return value;
  }
  const fallback = buildPersistedDetailsFallback(
    isRecord(originalDetails) ? originalDetails : undefined,
    originalSize,
    sanitizedBytes,
  );
  return jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES
    ? fallback
    : buildPersistedDetailsFallback(undefined, originalSize, sanitizedBytes);
}

function sanitizeToolResultDetailsForPersistence(details: unknown): unknown {
  if (details === undefined || details === null) {
    return details;
  }
  // Measure with an early-exit walker so hostile or enormous details do not
  // need to be fully stringified just to learn they exceed the persistence cap.
  const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
  if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return details;
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
    );
  }
  const out: Record<string, unknown> = {
    persistedDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
    originalDetailKeys: firstEnumerableOwnKeys(src, 40),
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
  });
  copyPersistedResultStateFields(out, src, MAX_PERSISTED_DETAIL_STRING_CHARS);
  if (typeof src.tail === "string") {
    out.tail = truncatePersistedDetailString(src.tail, MAX_PERSISTED_DETAIL_STRING_CHARS);
  }
  if (Array.isArray(src.sessions)) {
    out.sessions = src.sessions
      .slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT)
      .map((session) => sanitizePersistedSessionDetail(session));
    if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) {
      out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
    }
  }
  return enforcePersistedDetailsByteCap(out, src, originalSize);
}

export function capToolResultForPersistence(msg: AgentMessage, maxChars: number): AgentMessage {
  const capped = msg.role === "toolResult" ? truncateToolResultMessage(msg, maxChars) : msg;
  if (capped.role !== "toolResult") {
    return capped;
  }
  const details = capped.details;
  const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details);
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
