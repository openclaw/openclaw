import { popTools } from "./tool-store.js";

/**
 * Plugin tool factory registered via `api.registerTool`.
 * Receives the full `OpenClawPluginToolContext` including `sessionKey`,
 * so it's fully reentrant across concurrent requests.
 *
 * Returns AG-UI client-provided tools converted to agent tools,
 * or null if no client tools were stashed for this session.
 */
export function clawgUiToolFactory(ctx: { sessionKey?: string }) {
  const sessionKey = ctx.sessionKey;
  console.log(`[clawg-ui] clawgUiToolFactory: sessionKey=${sessionKey ?? "none"}`);
  if (!sessionKey) {
    console.log(`[clawg-ui] clawgUiToolFactory: returning null, no sessionKey`);
    return null;
  }
  const clientTools = popTools(sessionKey);
  console.log(`[clawg-ui] clawgUiToolFactory: popped ${clientTools.length} client tools`);
  if (clientTools.length === 0) {
    console.log(`[clawg-ui] clawgUiToolFactory: returning null, no client tools`);
    return null;
  }
  console.log(`[clawg-ui] clawgUiToolFactory: creating ${clientTools.length} agent tools`);
  for (const t of clientTools) {
    console.log(`[clawg-ui]   creating tool: name=${t.name}, description=${t.description ?? "(none)"}, hasParams=${!!t.parameters}, params=${JSON.stringify(t.parameters ?? {})}`);
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
      console.log(`[clawg-ui] client tool execute: name=${t.name}, args=${JSON.stringify(args)}`);
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
