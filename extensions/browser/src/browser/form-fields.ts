import type { BrowserFormField } from "./client-actions-core.js";

export const DEFAULT_FILL_FIELD_TYPE = "text";

type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;

export function normalizeBrowserFormFieldRef(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeBrowserFormFieldType(value: unknown): string {
  const type = typeof value === "string" ? value.trim() : "";
  return type || DEFAULT_FILL_FIELD_TYPE;
}

export function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

export function normalizeBrowserFormField(
  record: Record<string, unknown>,
): BrowserFormField | null {
  const ref = normalizeBrowserFormFieldRef(record.ref);
  if (!ref) {
    return null;
  }
  const type = normalizeBrowserFormFieldType(record.type);
  const value = normalizeBrowserFormFieldValue(record.value);
  return value === undefined ? { ref, type } : { ref, type, value };
}
