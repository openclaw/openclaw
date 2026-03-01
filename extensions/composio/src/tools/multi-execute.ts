import { Type } from "@sinclair/typebox";
import type { ComposioClient } from "../client.js";
import type { ComposioConfig } from "../types.js";

/**
 * Tool parameters for composio_multi_execute
 */
export const ComposioMultiExecuteToolSchema = Type.Object({
  executions: Type.Array(
    Type.Object({
      tool_slug: Type.String({
        description: "Tool slug from composio_search_tools results",
      }),
      arguments: Type.Unknown({
        description: "Tool arguments matching the tool's parameter schema",
      }),
    }),
    {
      description: "Array of tool executions to run in parallel (max 50)",
      maxItems: 50,
    },
  ),
  user_id: Type.Optional(
    Type.String({
      description: "User ID for session scoping (uses default if not provided)",
    }),
  ),
});

/**
 * Create the composio_multi_execute tool
 */
export function createComposioMultiExecuteTool(client: ComposioClient, _config: ComposioConfig) {
  return {
    name: "composio_multi_execute",
    label: "Composio Multi Execute",
    description:
      "Execute multiple Composio tools in parallel (up to 50). Use composio_search_tools first " +
      "to find tool slugs and parameter schemas. All tools must be connected.",
    parameters: ComposioMultiExecuteToolSchema,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const executions = Array.isArray(params.executions) ? params.executions : [];

      if (executions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "executions array is required and cannot be empty" },
                null,
                2,
              ),
            },
          ],
          details: { error: "executions array is required and cannot be empty" },
        };
      }

      // Validate and normalize executions
      const normalizedExecutions = executions
        .slice(0, 50)
        .filter(
          (exec): exec is { tool_slug: string } =>
            exec &&
            typeof exec === "object" &&
            typeof exec.tool_slug === "string" &&
            exec.tool_slug.trim() !== "",
        )
        .map((exec) => ({
          tool_slug: exec.tool_slug.trim(),
          arguments:
            exec.arguments && typeof exec.arguments === "object" && !Array.isArray(exec.arguments)
              ? (exec.arguments as Record<string, unknown>)
              : {},
        }));

      if (normalizedExecutions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "No valid executions provided" }, null, 2),
            },
          ],
          details: { error: "No valid executions provided" },
        };
      }

      const userId = typeof params.user_id === "string" ? params.user_id : undefined;

      try {
        const result = await client.multiExecute(normalizedExecutions, userId);

        const response = {
          total: normalizedExecutions.length,
          succeeded: result.results.filter((r) => r.success).length,
          failed: result.results.filter((r) => !r.success).length,
          results: result.results,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      } catch (err) {
        const errorResponse = {
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
