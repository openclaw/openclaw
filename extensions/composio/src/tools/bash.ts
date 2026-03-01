import { Type } from "@sinclair/typebox";
import type { ComposioClient } from "../client.js";
import type { ComposioConfig } from "../types.js";

/**
 * Tool parameters for composio_bash
 */
export const ComposioBashSchema = Type.Object({
  command: Type.String({
    description:
      "Bash command to execute in the remote sandbox. " +
      "Use for file operations, data processing with jq/awk/sed/grep, " +
      "or handling large tool responses saved to remote files. " +
      "Commands run from /home/user directory by default.",
  }),
  user_id: Type.Optional(
    Type.String({
      description: "User ID for session scoping (uses default if not provided)",
    }),
  ),
});

/**
 * Create the composio_bash tool
 */
export function createComposioBashTool(client: ComposioClient, _config: ComposioConfig) {
  return {
    name: "composio_bash",
    label: "Composio Remote Bash",
    description:
      "Execute bash commands in a remote sandbox for file operations, data processing, " +
      "and system tasks. Essential for handling large tool responses saved to remote files. " +
      "Use shell tools like jq, awk, sed, grep for data extraction.",
    parameters: ComposioBashSchema,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const command = String(params.command || "").trim();
      if (!command) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "command is required" }, null, 2) },
          ],
          details: { error: "command is required" },
        };
      }

      const userId = typeof params.user_id === "string" ? params.user_id : undefined;

      try {
        const result = await client.executeBash(command, userId);

        const response = {
          success: result.success,
          ...(result.success ? { output: result.output } : { error: result.error }),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      } catch (err) {
        const errorResponse = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }],
          details: errorResponse,
        };
      }
    },
  };
}
