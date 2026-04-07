export { asNullableRecord as asRecord } from "openclaw/plugin-sdk/text-runtime";
export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
