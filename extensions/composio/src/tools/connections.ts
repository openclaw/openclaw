import { Type } from "@sinclair/typebox";
import type { ComposioClient } from "../client.js";
import type { ComposioConfig } from "../types.js";

/**
 * Tool parameters for composio_manage_connections
 */
export const ComposioManageConnectionsToolSchema = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("create"), Type.Literal("list")], {
    description:
      "Action to perform: 'status' to check connections, 'create' to initiate auth, 'list' to list toolkits",
  }),
  toolkit: Type.Optional(
    Type.String({
      description: "Toolkit name for 'status' or 'create' actions (e.g., 'github', 'gmail')",
    }),
  ),
  toolkits: Type.Optional(
    Type.Array(Type.String(), {
      description: "Multiple toolkits to check status for",
    }),
  ),
  user_id: Type.Optional(
    Type.String({
      description: "User ID for session scoping (uses default if not provided)",
    }),
  ),
});

/**
 * Create the composio_manage_connections tool
 */
export function createComposioConnectionsTool(client: ComposioClient, _config: ComposioConfig) {
  return {
    name: "composio_manage_connections",
    label: "Composio Manage Connections",
    description:
      "Manage Composio toolkit connections. Check connection status, create new auth links, " +
      "or list available toolkits. Use this before executing tools to ensure authentication.",
    parameters: ComposioManageConnectionsToolSchema,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = String(params.action || "status");
      const userId = typeof params.user_id === "string" ? params.user_id : undefined;

      try {
        switch (action) {
          case "list": {
            const toolkits = await client.listToolkits(userId);
            const response = {
              action: "list",
              count: toolkits.length,
              toolkits,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "create": {
            const toolkit = String(params.toolkit || "").trim();
            if (!toolkit) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      { error: "toolkit is required for 'create' action" },
                      null,
                      2,
                    ),
                  },
                ],
                details: { error: "toolkit is required for 'create' action" },
              };
            }

            const result = await client.createConnection(toolkit, userId);
            if ("error" in result) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      { action: "create", toolkit, error: result.error },
                      null,
                      2,
                    ),
                  },
                ],
                details: { action: "create", toolkit, error: result.error },
              };
            }

            const response = {
              action: "create",
              toolkit,
              authUrl: result.authUrl,
              instructions: `Open the auth URL to connect ${toolkit}. After authentication, the connection will be active.`,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "status":
          default: {
            // Collect toolkits to check
            let toolkitsToCheck: string[] | undefined;

            if (typeof params.toolkit === "string" && params.toolkit.trim()) {
              toolkitsToCheck = [params.toolkit.trim()];
            } else if (Array.isArray(params.toolkits)) {
              toolkitsToCheck = params.toolkits.filter(
                (t): t is string => typeof t === "string" && t.trim() !== "",
              );
            }

            const statuses = await client.getConnectionStatus(toolkitsToCheck, userId);
            const response = {
              action: "status",
              count: statuses.length,
              connections: statuses.map((s) => ({
                toolkit: s.toolkit,
                connected: s.connected,
              })),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }
        }
      } catch (err) {
        const errorResponse = {
          action,
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
