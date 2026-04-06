/**
 * Bridge OpenClaw's AgentTool format to the Copilot SDK's Tool format.
 *
 * OpenClaw AgentTool:
 *   { name, description, parameters, label, execute(id, params, signal) → {content, details} }
 *
 * Copilot SDK Tool:
 *   { name, description, parameters, handler(args, invocation) → ToolResultObject }
 */
import type { Tool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import type { AnyAgentTool } from "../pi-tools.types.js";

/**
 * Convert an OpenClaw AgentTool into a Copilot SDK Tool definition.
 *
 * Returns a structured ToolResultObject so errors are properly reported.
 */
export function bridgeTool(agentTool: AnyAgentTool): Tool {
  return {
    name: agentTool.name,
    description: agentTool.description,
    parameters: agentTool.parameters as Record<string, unknown> | undefined,
    handler: async (args: unknown, invocation: ToolInvocation): Promise<ToolResultObject> => {
      const preparedArgs = agentTool.prepareArguments ? agentTool.prepareArguments(args) : args;

      try {
        const result = await agentTool.execute(
          invocation.toolCallId,
          preparedArgs,
          undefined, // AbortSignal — not available from SDK invocation
        );

        const textParts = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);

        return {
          textResultForLlm: textParts.join("\n") || "OK",
          resultType: "success",
        };
      } catch (err) {
        return {
          textResultForLlm: "",
          resultType: "failure",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Convert an array of OpenClaw AgentTools into Copilot SDK Tools.
 *
 * Filters out tools that conflict with Copilot runtime built-in tools
 * (bash, read, write, edit) since the runtime already provides those.
 */
const RUNTIME_BUILTIN_TOOLS = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
]);

export function bridgeTools(agentTools: AnyAgentTool[]): Tool[] {
  return agentTools.filter((t) => !RUNTIME_BUILTIN_TOOLS.has(t.name)).map(bridgeTool);
}
