import { getPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tool-metadata.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { McpServerInstructionsEntry } from "./system-prompt-tool-list.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Collects server instructions from the final tool list and from catalog entries
 * that stay callable behind Code Mode or Tool Search controls. Both come from the
 * policy-filtered tools, so servers whose tools were all removed by policy,
 * filters, or session denials contribute nothing.
 */
export function collectMcpServerInstructions(
  tools: readonly { name: string }[],
  catalogEntries: readonly { mcp?: PluginToolMcpMeta }[] = [],
): McpServerInstructionsEntry[] {
  const servers = new Map<string, McpServerInstructionsEntry>();
  const metas = [
    // SAFETY: metadata is a WeakMap keyed by tool identity; prompt tools are the agent tool objects.
    ...tools.map((tool) => getPluginToolMeta(tool as AnyAgentTool)?.mcp),
    ...catalogEntries.map((entry) => entry.mcp),
  ];
  for (const mcp of metas) {
    if (
      !mcp?.serverInstructions ||
      mcp.excludedFromOpenClawCatalog ||
      mcp.deniedBySession ||
      servers.has(mcp.serverName)
    ) {
      continue;
    }
    servers.set(mcp.serverName, {
      serverName: mcp.serverName,
      toolPrefix: `${mcp.safeServerName}${TOOL_NAME_SEPARATOR}`,
      instructions: mcp.serverInstructions,
    });
  }
  return [...servers.values()].toSorted((a, b) => a.serverName.localeCompare(b.serverName));
}
