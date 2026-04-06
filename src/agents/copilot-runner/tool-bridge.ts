/**
 * Bridge OpenClaw's AgentTool format to the Copilot SDK's Tool format.
 *
 * OpenClaw AgentTool:
 *   { name, description, parameters (TSchema), label, execute(id, params, signal) → {content, details} }
 *
 * Copilot SDK Tool:
 *   { name, description, parameters (JSON Schema), handler(args, invocation) → string | ToolResultObject }
 *
 * This module converts between the two so OpenClaw-specific tools (messaging,
 * media, cron, sessions, etc.) can be passed to the Copilot SDK session.
 */
import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import type { AnyAgentTool } from "../pi-tools.types.js";

/**
 * Convert an OpenClaw AgentTool into a Copilot SDK Tool definition.
 *
 * The SDK handler calls the AgentTool's execute() and converts the
 * AgentToolResult (content array) into the text string the SDK expects.
 */
export function bridgeTool(agentTool: AnyAgentTool): Tool {
  return {
    name: agentTool.name,
    description: agentTool.description,
    // The SDK accepts raw JSON Schema objects for parameters.
    parameters: agentTool.parameters as Record<string, unknown> | undefined,
    handler: async (args: unknown, invocation: ToolInvocation) => {
      const preparedArgs = agentTool.prepareArguments ? agentTool.prepareArguments(args) : args;

      const result = await agentTool.execute(
        invocation.toolCallId,
        preparedArgs,
        undefined, // AbortSignal — not available from SDK invocation
      );

      // Convert AgentToolResult.content[] → text string for the SDK.
      const textParts = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);

      return textParts.join("\n") || "OK";
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
