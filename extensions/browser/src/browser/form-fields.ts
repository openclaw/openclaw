import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserFormField } from "./client-actions.types.js";

export const DEFAULT_FILL_FIELD_TYPE = "text";

const FIELD_ENTRY_KEYS = new Set(["ref", "type", "value"]);

/** Normalize form field descriptors and preserve the failing entry index. */
export function normalizeBrowserFormFields(entries: unknown[]): BrowserFormField[] {
  return entries.map((record, index) => {
    if (!isRecord(record)) {
      throw new Error(`fields[${index}] must be an object`);
    }
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
    const value = record.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${prefix} value must be a string, number, boolean, or null`);
    }
    return { ref, type, value };
  });
}
