import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { McpServerInstructionsEntry } from "./system-prompt-tool-list.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Collects server instructions from the final tool list, so servers whose tools
 * were all removed by policy, filters, or session denials contribute nothing.
 */
export function collectMcpServerInstructions(
  tools: readonly { name: string }[],
): McpServerInstructionsEntry[] {
  const servers = new Map<string, McpServerInstructionsEntry>();
  for (const tool of tools) {
    // SAFETY: metadata is a WeakMap keyed by tool identity; prompt tools are the agent tool objects.
    const mcp = getPluginToolMeta(tool as AnyAgentTool)?.mcp;
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
