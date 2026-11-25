import type { AnyAgentTool } from "./tools/common.js";

const serverInstructionsByTool = new WeakMap<
  object,
  { serverName: string; instructions: string }
>();

/** Records the upstream server guidance that accompanies a bridged MCP tool. */
export function setBundleMcpToolServerInstructions(
  tool: AnyAgentTool,
  serverName: string,
  instructions: string | undefined,
): void {
  if (instructions) {
    serverInstructionsByTool.set(tool, { serverName, instructions });
  }
}

/**
 * Server instructions for the loopback initialize reply. A server contributes
 * only while one of its tools is listed, so a fully denied server adds nothing;
 * servers are ordered by name so the reply, and Claude's prompt, stay stable.
 */
export function resolveBundleMcpServerInstructions(
  tools: readonly AnyAgentTool[] | undefined,
  listedToolNames: ReadonlySet<string>,
): string | undefined {
  const byServer = new Map<string, string>();
  for (const tool of tools ?? []) {
    const entry = serverInstructionsByTool.get(tool);
    if (entry && listedToolNames.has(tool.name)) {
      byServer.set(entry.serverName, entry.instructions);
    }
  }
  const parts = [...byServer.keys()]
    .toSorted()
    .map((serverName) => `## ${serverName}\n${byServer.get(serverName)}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
