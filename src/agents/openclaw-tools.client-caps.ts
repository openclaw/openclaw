import { gateAgentToolExecution } from "./agent-tool-availability.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Client availability gates execution, not the session's model-facing declaration. */
export function gateToolByClientCaps(
  tool: AnyAgentTool,
  clientCaps: ReadonlySet<string>,
): AnyAgentTool {
  return tool.requiredClientCaps?.some((cap) => !clientCaps.has(cap))
    ? gateAgentToolExecution(
        tool,
        tool.name +
          " requires a connected client with " +
          tool.requiredClientCaps.join(", ") +
          ". This turn has no eligible client; do not retry.",
      )
    : tool;
}

export function gateToolsByClientCaps(
  tools: AnyAgentTool[],
  declaredClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const clientCaps = new Set(declaredClientCaps ?? []);
  return tools.map((tool) => gateToolByClientCaps(tool, clientCaps));
}
