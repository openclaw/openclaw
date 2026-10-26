import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";
import { matchesStarSegments } from "../shared/star-pattern.js";

/** Match the documented MCP tool-filter glob syntax: exact text plus `*`. */
function matchesMcpToolFilterPattern(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }

  const parts = trimmed.split("*");
  return matchesStarSegments(
    {
      first: parts[0] ?? "",
      last: parts.at(-1) ?? "",
      interior: parts.slice(1, -1).filter(Boolean),
    },
    value,
  );
}

/** Normalizes open-world MCP tool filters into the runtime policy shape. */
export function normalizeMcpToolFilter(raw: unknown): McpServerToolFilterConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const include = filterStringEntries(raw.include);
  const exclude = filterStringEntries(raw.exclude);
  if (include.length === 0 && exclude.length === 0) {
    return undefined;
  }
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/** Applies the shared include-then-exclude policy. */
export function isMcpToolAllowed(
  toolFilter: McpServerToolFilterConfig | undefined,
  toolName: string,
): boolean {
  const matches = (pattern: string) => matchesMcpToolFilterPattern(pattern, toolName);
  return (
    (!toolFilter?.include?.length || toolFilter.include.some(matches)) &&
    !toolFilter?.exclude?.some(matches)
  );
}
