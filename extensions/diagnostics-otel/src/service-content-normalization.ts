import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
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

export function normalizeOtelContentValue(value: unknown): string | undefined {
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
  return safeJsonString(value);
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

export function safeJsonString(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  const exact = stringifyJsonForOtelAttribute(value);
  if (exact && exact.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
    return exact;
  }
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      const candidate = truncateJsonValueForOtelAttribute(value, maxArrayItems, maxStringChars);
      const json = stringifyJsonForOtelAttribute(candidate);
      if (json && json.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
        return json;
      }
    }
  }
  const summary = stringifyJsonForOtelAttribute({
    truncated: true,
    reason: exact ? "max_attribute_size" : "unserializable_value",
    type: describeJsonValue(value),
  });
  return summary && summary.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS ? summary : undefined;
}

function stringifyJsonForOtelAttribute(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return undefined;
    }
    return redactSensitiveText(json);
  } catch {
    return undefined;
  }
}

function truncateJsonValueForOtelAttribute(
  input: unknown,
  maxArrayItems: number,
  maxStringChars: number,
): unknown {
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string" || typeof value === "bigint") {
      return truncateJsonTextForOtelAttribute(String(value), maxStringChars);
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

function truncateJsonTextForOtelAttribute(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value);
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
