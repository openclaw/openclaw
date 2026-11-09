import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";

export type OtelContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
  toolDefinitions: boolean;
  logBodies: boolean;
};

const NO_CONTENT_CAPTURE: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  logBodies: false,
};

function clampOtelLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${truncateUtf16Safe(value, maxChars)}...(truncated)` : value;
}

export function normalizeOtelLogString(value: string, maxChars: number): string {
  return clampOtelLogText(redactSensitiveText(value), maxChars);
}

export function normalizeOtelErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeOtelLogString(value.trim(), MAX_OTEL_ERROR_MESSAGE_CHARS);
  return normalized || undefined;
}

export function resolveContentCapturePolicy(value: unknown): OtelContentCapturePolicy {
  return value === true
    ? {
        inputMessages: true,
        outputMessages: true,
        toolInputs: true,
        toolOutputs: true,
        systemPrompt: false,
        toolDefinitions: true,
        logBodies: true,
      }
    : NO_CONTENT_CAPTURE;
}

export function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

export type OtelContentRedactor = (value: string) => string;

// Redaction is the dominant cost of content capture, and a string's redaction does
// not depend on which attribute or truncation budget it lands in. One redactor per
// export redacts each captured string once instead of once per budget attempt and
// per attribute that carries the same message. A memo rather than a pre-redacted
// tree, because each attribute walks a different shape built from the same strings.
// Scope it to one export: it holds the redacted copies until it is dropped.
export function createOtelContentRedactor(): OtelContentRedactor {
  const redacted = new Map<string, string>();
  return (value) => {
    let result = redacted.get(value);
    if (result === undefined) {
      result = redactSensitiveText(value);
      redacted.set(value, result);
    }
    return result;
  };
}

export function normalizeOtelContentValue(
  value: unknown,
  redact: OtelContentRedactor = createOtelContentRedactor(),
): string | undefined {
  if (typeof value === "string") {
    return clampOtelLogText(redact(value), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
      if (typeof item === "string") {
        items.push(item);
      }
    }
    if (items.length > 0) {
      return clampOtelLogText(redact(items.join("\n")), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  const json = safeJsonString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS, redact);
  if (json) {
    return json;
  }
  return undefined;
}

const TRUNCATED_JSON_TEXT_SUFFIX = "...(truncated)";
const JSON_TRUNCATION_STRING_BUDGETS = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32] as const;
const JSON_TRUNCATION_ARRAY_ITEM_BUDGETS = [
  MAX_OTEL_CONTENT_ARRAY_ITEMS,
  100,
  50,
  25,
  10,
  5,
  1,
] as const;
const JSON_TRUNCATION_MAX_OBJECT_FIELDS = 64;
const JSON_TRUNCATION_MAX_DEPTH = 8;

type JsonTruncationOptions = {
  maxArrayItems: number;
  maxDepth: number;
  maxObjectFields: number;
  maxStringChars: number;
  seen: WeakSet<object>;
  redact: OtelContentRedactor;
};

// Values far beyond an attribute budget skip full redaction; each retained string
// is still redacted before the bounded fallback truncates it.
const MAX_OTEL_REDACTED_JSON_CANDIDATE_CHARS = 4 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;

export function safeJsonString(
  value: unknown,
  maxChars: number,
  redact: OtelContentRedactor = createOtelContentRedactor(),
): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  const json = serializeJsonForOtelAttribute(value);
  const exact = redactJsonWithinAttributeBudget(json, maxChars);
  if (exact) {
    return exact;
  }
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      const candidate = truncateJsonValueForOtelAttribute(value, {
        maxArrayItems,
        maxDepth: JSON_TRUNCATION_MAX_DEPTH,
        maxObjectFields: JSON_TRUNCATION_MAX_OBJECT_FIELDS,
        maxStringChars,
        seen: new WeakSet<object>(),
        redact,
      });
      const truncated = redactJsonWithinAttributeBudget(
        serializeJsonForOtelAttribute(candidate),
        maxChars,
      );
      if (truncated) {
        return truncated;
      }
    }
  }
  return redactJsonWithinAttributeBudget(
    serializeJsonForOtelAttribute({
      truncated: true,
      reason: json ? "max_attribute_size" : "unserializable_value",
      type: describeJsonValue(value),
    }),
    maxChars,
  );
}

function serializeJsonForOtelAttribute(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) || undefined;
  } catch {
    return undefined;
  }
}

function redactJsonWithinAttributeBudget(
  json: string | undefined,
  maxChars: number,
): string | undefined {
  if (!json || json.length > MAX_OTEL_REDACTED_JSON_CANDIDATE_CHARS) {
    return undefined;
  }
  const redacted = redactSensitiveText(json);
  return redacted.length <= maxChars ? redacted : undefined;
}

function truncateJsonValueForOtelAttribute(
  value: unknown,
  options: JsonTruncationOptions,
): unknown {
  if (typeof value === "string") {
    return truncateJsonTextForOtelAttribute(options.redact(value), options.maxStringChars);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    return truncateJsonTextForOtelAttribute(options.redact(String(value)), options.maxStringChars);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (options.maxDepth <= 0) {
    return { truncated: true, reason: "max_depth" };
  }
  if (Array.isArray(value)) {
    return truncateJsonArrayForOtelAttribute(value, options);
  }
  if (typeof value === "object") {
    return truncateJsonObjectForOtelAttribute(value as Record<string, unknown>, options);
  }
  return undefined;
}

function truncateJsonArrayForOtelAttribute(
  value: readonly unknown[],
  options: JsonTruncationOptions,
): unknown[] {
  if (options.seen.has(value)) {
    return [{ truncated: true, reason: "circular_reference" }];
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const items = value
    .slice(0, options.maxArrayItems)
    .map((item) => truncateJsonValueForOtelAttribute(item, nextOptions));
  if (value.length > items.length) {
    items.push({ truncated: true, omittedItems: value.length - items.length });
  }
  options.seen.delete(value);
  return items;
}

function truncateJsonObjectForOtelAttribute(
  value: Record<string, unknown>,
  options: JsonTruncationOptions,
): Record<string, unknown> {
  if (options.seen.has(value)) {
    return { truncated: true, reason: "circular_reference" };
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).filter(
    ([, field]) => field !== undefined && typeof field !== "function" && typeof field !== "symbol",
  );
  for (const [key, field] of entries.slice(0, options.maxObjectFields)) {
    result[key] = truncateJsonValueForOtelAttribute(field, nextOptions);
  }
  if (entries.length > options.maxObjectFields) {
    result.truncated = true;
    result.omittedFields = entries.length - options.maxObjectFields;
  }
  options.seen.delete(value);
  return result;
}

function truncateJsonTextForOtelAttribute(redacted: string, maxChars: number): string {
  if (redacted.length <= maxChars) {
    return redacted;
  }
  const suffixBudget = Math.min(TRUNCATED_JSON_TEXT_SUFFIX.length, maxChars);
  const prefixBudget = Math.max(0, maxChars - suffixBudget);
  return `${truncateUtf16Safe(redacted, prefixBudget)}${TRUNCATED_JSON_TEXT_SUFFIX.slice(
    TRUNCATED_JSON_TEXT_SUFFIX.length - suffixBudget,
  )}`;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
