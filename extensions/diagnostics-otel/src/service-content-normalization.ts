import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";

export function normalizeOtelLogString(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value);
  return redacted.length > maxChars
    ? `${truncateUtf16Safe(redacted, maxChars)}...(truncated)`
    : redacted;
}

export function normalizeOtelErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeOtelLogString(value.trim(), MAX_OTEL_ERROR_MESSAGE_CHARS);
  return normalized || undefined;
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
  redact?: OtelContentRedactor,
): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)
      .filter((item): item is string => typeof item === "string");
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  return safeJsonString(value, redact);
}

export function assignOtelContentAttr(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
  redact?: OtelContentRedactor,
): void {
  const normalized = normalizeOtelContentValue(value, redact);
  if (normalized) {
    attributes[key] = normalized;
  }
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
// Masking can shorten a value, so JSON a little over the attribute budget may still
// fit once redacted. Far past it, redacting the whole serialization only to learn it
// is too large dominated content capture (#158116); such a value moves on to the next
// truncation candidate instead, whose strings are each redacted before truncation.
const MAX_OTEL_REDACTED_JSON_CANDIDATE_CHARS = 4 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;

export function safeJsonString(
  value: unknown,
  redact: OtelContentRedactor = createOtelContentRedactor(),
): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  const json = serializeJsonForOtelAttribute(value);
  const exact = redactJsonWithinAttributeBudget(json);
  if (exact) {
    return exact;
  }
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      const candidate = truncateJsonValueForOtelAttribute(
        value,
        maxArrayItems,
        maxStringChars,
        redact,
      );
      const truncated = redactJsonWithinAttributeBudget(serializeJsonForOtelAttribute(candidate));
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
  );
}

function serializeJsonForOtelAttribute(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) || undefined;
  } catch {
    return undefined;
  }
}

function redactJsonWithinAttributeBudget(json: string | undefined): string | undefined {
  if (!json || json.length > MAX_OTEL_REDACTED_JSON_CANDIDATE_CHARS) {
    return undefined;
  }
  const redacted = redactSensitiveText(json);
  return redacted.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS ? redacted : undefined;
}

function truncateJsonValueForOtelAttribute(
  input: unknown,
  maxArrayItems: number,
  maxStringChars: number,
  redact: OtelContentRedactor,
): unknown {
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string" || typeof value === "bigint") {
      return truncateJsonTextForOtelAttribute(redact(String(value)), maxStringChars);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (typeof value !== "object") {
      return undefined;
    }
    if (depth <= 0) {
      return { truncated: true, reason: "max_depth" };
    }
    if (seen.has(value)) {
      const marker = { truncated: true, reason: "circular_reference" };
      return Array.isArray(value) ? [marker] : marker;
    }
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const items = value.slice(0, maxArrayItems).map((item) => visit(item, depth - 1));
      if (value.length > items.length) {
        items.push({ truncated: true, omittedItems: value.length - items.length });
      }
      result = items;
    } else {
      const object: Record<string, unknown> = {};
      const entries = Object.entries(value).filter(
        ([, field]) =>
          field !== undefined && typeof field !== "function" && typeof field !== "symbol",
      );
      for (const [key, field] of entries.slice(0, JSON_TRUNCATION_MAX_OBJECT_FIELDS)) {
        object[key] = visit(field, depth - 1);
      }
      if (entries.length > JSON_TRUNCATION_MAX_OBJECT_FIELDS) {
        object.truncated = true;
        object.omittedFields = entries.length - JSON_TRUNCATION_MAX_OBJECT_FIELDS;
      }
      result = object;
    }
    seen.delete(value);
    return result;
  }
  return visit(input, JSON_TRUNCATION_MAX_DEPTH);
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
