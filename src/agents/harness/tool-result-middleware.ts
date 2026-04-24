import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewares } from "../../plugins/agent-tool-result-middleware.js";

const log = createSubsystemLogger("agents/harness");

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers: AgentToolResultMiddleware[] = listAgentToolResultMiddlewares(ctx.harness),
) {
  return {
    async applyToolResultMiddleware(
      event: AgentToolResultMiddlewareEvent,
    ): Promise<OpenClawAgentToolResult> {
      let current = event.result;
      for (const handler of handlers) {
        try {
          const next = await handler({ ...event, result: current }, ctx);
          if (next?.result) {
            current = next.result;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(
            `[${ctx.harness}] tool result middleware failed for ${event.toolName}: ${detail}`,
          );
        }
      }
      return current;
    },
  };
}
