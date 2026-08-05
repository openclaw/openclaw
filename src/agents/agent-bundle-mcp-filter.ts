import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Match the documented MCP tool-filter glob syntax: exact text plus `*`. */
export function matchesMcpToolFilterPattern(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }

  const parts = trimmed.split("*");
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  let cursor = 0;
  if (first) {
    if (!value.startsWith(first)) {
      return false;
    }
    cursor = first.length;
  }
  const endBound = last ? value.length - last.length : value.length;
  if (last && (!value.endsWith(last) || endBound < cursor)) {
    return false;
  }

  for (const part of parts.slice(1, -1)) {
    if (!part) {
      continue;
    }
    const index = value.indexOf(part, cursor);
    if (index === -1 || index + part.length > endBound) {
      return false;
    }
    cursor = index + part.length;
  }
  return true;
}

/** True only for patterns that match every possible MCP tool or utility name. */
function isUniversalMcpToolFilterPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return /^\*+$/u.test(trimmed);
}

/** Proves that a raw MCP tool filter excludes the server's entire callable surface. */
export function mcpToolFilterExcludesAll(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.exclude)) {
    return false;
  }
  return value.exclude.some(
    (pattern) => typeof pattern === "string" && isUniversalMcpToolFilterPattern(pattern),
  );
}
