import { popTools } from "./tool-store.js";

/**
 * Plugin tool factory registered via `api.registerTool`.
 * Receives the full `OpenClawPluginToolContext` including `sessionKey`,
 * so it's fully reentrant across concurrent requests.
 *
 * Returns AG-UI client-provided tools converted to agent tools,
 * or null if no client tools were stashed for this session.
 */
export function aguiToolFactory(ctx: { sessionKey?: string }) {
  const sessionKey = ctx.sessionKey;
  if (!sessionKey) {
    return null;
  }
  const clientTools = popTools(sessionKey);
  if (clientTools.length === 0) {
    return null;
  }
  return clientTools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters ?? { type: "object", properties: {} },
    async execute(_toolCallId: string, args: unknown) {
      // Client-side tools are fire-and-forget per AG-UI protocol.
      // TOOL_CALL_START/ARGS/END are emitted by the before_tool_call hook.
      // The run ends, and the client initiates a new run with the tool result.
      // Return args so the agent loop can continue (the dispatcher will
      // suppress any text output after a client tool call).
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(args),
          },
        ],
        details: { clientTool: true, name: t.name, args },
      };
    },
  }));
}
