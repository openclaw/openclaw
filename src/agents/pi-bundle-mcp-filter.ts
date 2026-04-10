import { logInfo, logWarn } from "../logger.js";

export type McpToolFilter = {
  allow?: string[];
  deny?: string[];
};

/**
 * Apply a per-server allow/deny filter to the tool list discovered from an MCP server.
 *
 * Semantics:
 * - No filter, or filter with neither `allow` nor `deny` set → return tools unchanged.
 * - `allow` defines the universe of permitted tools; anything not listed is dropped.
 * - `deny` carves exceptions; anything listed is dropped.
 * - When both are present, `allow` runs first, then `deny` — so a tool present in both
 *   lists is dropped (deny wins on overlap).
 * - Matching is case-sensitive. MCP tool names are case-sensitive per the MCP spec.
 * - Duplicate entries in `allow`/`deny` are deduped on ingress so warnings fire only once.
 * - Unknown `allow` entries (names not present on the server) emit a warning — this is
 *   typically a typo or an upstream rename, both of which the operator should know about.
 *   Unknown `deny` entries are silent because denying a non-existent tool is idempotent
 *   and often intentional (defensive config).
 *
 * The filter is a **context-budget mechanism**, not an access-control mechanism.
 * Denying a tool here prevents models from seeing it in the catalog, but does NOT prevent
 * direct invocation by name through the runtime's `callTool` path (which bypasses catalog
 * filtering). Do not rely on this filter as a security boundary.
 *
 * Generic on `T extends { name: string }` so it can be called directly on the SDK
 * `ListedTool` shape without an adapter.
 */
export function applyMcpToolFilter<T extends { name: string }>(params: {
  serverName: string;
  tools: T[];
  filter?: McpToolFilter;
}): T[] {
  const { serverName, tools, filter } = params;
  if (!filter || (filter.allow === undefined && filter.deny === undefined)) {
    return tools;
  }

  // Defensive: bundle-provided MCP configs reach this function via a runtime
  // cast in pi-bundle-mcp-runtime.ts and are not always zod-validated, so
  // allow/deny may be arbitrary runtime values (e.g. `true`, `{}`, `[]`) despite
  // the TypeScript type. Coerce non-array shapes to undefined and warn the
  // operator instead of letting `new Set(...)` throw on a non-iterable.
  // Empty arrays are also rejected — an `allow: []` would silently hide every
  // tool on the server with only an info log, the exact footgun Zod's `.min(1)`
  // guards against on the user-config path.
  let allow: string[] | undefined;
  if (filter.allow !== undefined) {
    if (!Array.isArray(filter.allow)) {
      logWarn(
        `bundle-mcp: server "${serverName}" tools.allow is not an array — ignoring`,
      );
    } else if (filter.allow.length === 0) {
      logWarn(
        `bundle-mcp: server "${serverName}" tools.allow is empty — ignoring (use deny to remove specific tools)`,
      );
    } else {
      allow = filter.allow;
    }
  }
  let deny: string[] | undefined;
  if (filter.deny !== undefined) {
    if (!Array.isArray(filter.deny)) {
      logWarn(
        `bundle-mcp: server "${serverName}" tools.deny is not an array — ignoring`,
      );
    } else if (filter.deny.length === 0) {
      logWarn(
        `bundle-mcp: server "${serverName}" tools.deny is empty — ignoring`,
      );
    } else {
      deny = filter.deny;
    }
  }
  if (!allow && !deny) {
    return tools;
  }

  let filtered = tools;

  if (allow) {
    const allowSet = new Set(allow);
    const seenOnServer = new Set(tools.map((tool) => tool.name));
    for (const entry of allowSet) {
      if (!seenOnServer.has(entry)) {
        logWarn(
          `bundle-mcp: allow-list entry "${entry}" not found on server "${serverName}" (typo or upstream rename?)`,
        );
      }
    }
    filtered = filtered.filter((tool) => allowSet.has(tool.name));
  }

  if (deny) {
    const denySet = new Set(deny);
    filtered = filtered.filter((tool) => !denySet.has(tool.name));
  }

  if (filtered.length !== tools.length) {
    logInfo(
      `bundle-mcp: server "${serverName}" filter applied — ${filtered.length} of ${tools.length} tools exposed`,
    );
  }

  return filtered;
}
