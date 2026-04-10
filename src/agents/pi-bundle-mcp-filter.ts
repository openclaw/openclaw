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
 * The filter is a **context-budget mechanism**, not an access-control mechanism. See the
 * note in pi-bundle-mcp-runtime.ts `callTool` for why denying a tool here does NOT prevent
 * direct invocation by name via the runtime.
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
  if (!filter || (!filter.allow && !filter.deny)) {
    return tools;
  }

  let filtered = tools;

  if (filter.allow) {
    const allowSet = new Set(filter.allow);
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

  if (filter.deny) {
    const denySet = new Set(filter.deny);
    filtered = filtered.filter((tool) => !denySet.has(tool.name));
  }

  if (filtered.length !== tools.length) {
    logInfo(
      `bundle-mcp: server "${serverName}" filter applied — ${filtered.length} of ${tools.length} tools exposed`,
    );
  }

  return filtered;
}
