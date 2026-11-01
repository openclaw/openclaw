import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeCappedStringList(value: unknown, field: "labels" | "parents"): string[] {
  if (value == null) {
    return [];
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error(`${field} must be an array or comma-separated string.`);
  }
  const maxLength = field === "labels" ? 40 : 120;
  const maxEntries = field === "labels" ? 12 : 20;
  const values: string[] = [];
  for (const entry of entries) {
    if (field === "parents" && typeof entry !== "string") {
      throw new Error("parents must contain only strings.");
    }
    const normalized = normalizeOptionalString(entry);
    if (!normalized || values.includes(normalized)) {
      continue;
    }
    if (normalized.length > maxLength) {
      throw new Error(`${field} must be ${maxLength} characters or fewer.`);
    }
    values.push(normalized);
    if (values.length >= maxEntries) {
      break;
    }
  }
  return values;
}
