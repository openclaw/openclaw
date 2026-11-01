import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";
import { matchesStarSegments } from "../shared/star-pattern.js";
import { safeToolNameCandidate } from "./agent-bundle-mcp-names.js";
import type { McpServerCatalog, McpToolCatalog } from "./agent-bundle-mcp-types.js";

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

/** The complete server inventory, before filtering, including supported utilities. */
export type McpToolFilterScope = Pick<McpServerCatalog, "resources" | "prompts"> & {
  safeServerName: string;
  toolNames: readonly string[];
};

/** Reads a server's full advertised inventory, including filtered tools, from a catalog. */
export function mcpCatalogToolFilterScope(
  catalog: McpToolCatalog,
  serverName: string,
): McpToolFilterScope {
  const tools = catalog.policyTools ?? [...catalog.tools, ...(catalog.sessionDeniedTools ?? [])];
  const server = catalog.servers[serverName];
  return {
    safeServerName: server?.safeServerName ?? serverName,
    toolNames: tools.filter((tool) => tool.serverName === serverName).map((tool) => tool.toolName),
    resources: server?.resources,
    prompts: server?.prompts,
  };
}

/**
 * Resolve probe aliases once against the full inventory. Raw names and globs
 * retain their meaning. Includes accept only a unique unsuffixed owner;
 * excludes hide every possible owner, including collision-suffixed owners.
 * Without a scope, matching is raw-only.
 */
export function createMcpToolFilter(
  toolFilter: McpServerToolFilterConfig | undefined,
  scope?: McpToolFilterScope,
): (toolName: string) => boolean {
  const rawNames = new Set([
    ...(scope?.toolNames ?? []),
    ...(scope?.resources ? ["resources_list", "resources_read"] : []),
    ...(scope?.prompts ? ["prompts_list", "prompts_get"] : []),
  ]);
  const compileEntries = (patterns: string[] | undefined, exclude: boolean) =>
    (patterns ?? []).map((pattern) => {
      const entry = pattern.trim();
      if (!scope || entry.includes("*") || rawNames.has(entry)) {
        return (toolName: string) => matchesMcpToolFilterPattern(entry, toolName);
      }
      const candidate = (toolName: string, attempt = 1) =>
        safeToolNameCandidate({ serverName: scope.safeServerName, toolName, attempt });
      const suffixAttempt = Number(/-(\d+)$/.exec(entry)?.[1] ?? 1);
      const owners = [...rawNames].filter(
        (name) => candidate(name) === entry || candidate(name, suffixAttempt) === entry,
      );
      const selected = exclude
        ? owners
        : owners.filter((name) => owners.length === 1 && candidate(name) === entry);
      return (toolName: string) => selected.includes(toolName);
    });
  const include = compileEntries(toolFilter?.include, false);
  const exclude = compileEntries(toolFilter?.exclude, true);
  return (toolName) =>
    (!toolFilter?.include?.length || include.some((matches) => matches(toolName))) &&
    !exclude.some((matches) => matches(toolName));
}
