import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserFormField } from "./client-actions.types.js";

export const DEFAULT_FILL_FIELD_TYPE = "text";

const FIELD_ENTRY_KEYS = new Set(["ref", "type", "value"]);

type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;

function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function normalizeBrowserFormField(
  record: Record<string, unknown>,
  index: number,
): BrowserFormField {
  const prefix = `fields[${index}]`;
  const ref = normalizeOptionalString(record.ref);
  if (!ref) {
    throw new Error(`${prefix} must include ref`);
  }
  for (const key of Object.keys(record)) {
    if (!FIELD_ENTRY_KEYS.has(key)) {
      throw new Error(
        `${prefix} unsupported field key "${key}"; supported keys are ref, type, value`,
      );
    }
  }
  const type = normalizeOptionalString(record.type) ?? DEFAULT_FILL_FIELD_TYPE;
  if (record.value === undefined || record.value === null) {
    return { ref, type };
  }
  const value = normalizeBrowserFormFieldValue(record.value);
  if (value === undefined) {
    throw new Error(`${prefix} value must be a string, number, boolean, or null`);
  }
  return { ref, type, value };
}

/** Normalize form field descriptors and preserve the failing entry index. */
export function normalizeBrowserFormFields(entries: unknown[]): BrowserFormField[] {
  return entries.map((field, index) => {
    if (!isRecord(field)) {
      throw new Error(`fields[${index}] must be an object`);
    }
    return normalizeBrowserFormField(field, index);
  });
}
