import {
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getPolicyPath } from "../policy-value.js";
export { readBooleanPath as readPolicyBoolean } from "../policy-state-helpers.js";

export function readPolicyStringArray(
  policy: unknown,
  path: readonly string[],
  options: { readonly lowercase?: boolean } = {},
): readonly string[] | undefined {
  const current = getPolicyPath(policy, path);
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return options.lowercase === false
    ? normalizeStringEntries(current)
    : normalizeStringEntriesLower(current);
}

export function readStringList(
  policy: unknown,
  path: readonly string[],
  options?: { readonly lowercase?: boolean },
): readonly string[] {
  return readPolicyStringArray(policy, path, options) ?? [];
}

export function readPolicyPathString(policy: unknown, path: readonly string[]): string | undefined {
  const current = getPolicyPath(policy, path);
  return typeof current === "string" ? current.trim().toLowerCase() : undefined;
}

export function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
