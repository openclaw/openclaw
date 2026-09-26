import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServerRequestContext } from "../plugins/types.mcp-connection.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type RequestScope = { context: McpServerRequestContext | undefined; active: boolean };
const scopes = resolveGlobalSingleton<AsyncLocalStorage<RequestScope>>(
  Symbol.for("openclaw.mcpRequestContext"),
  () => new AsyncLocalStorage(),
);

export function getMcpRequestContext(): McpServerRequestContext | undefined {
  const scope = scopes.getStore();
  return scope?.active ? scope.context : undefined;
}

/** Run one MCP operation with immutable attribution; undefined explicitly clears it. */
export async function runWithMcpRequestContext<T>(
  context: McpServerRequestContext | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const scope: RequestScope = {
    context: context
      ? Object.freeze({
          sessionId: context.sessionId,
          sessionKey: context.sessionKey,
          runId: context.runId,
          ...(context.metadata ? { metadata: Object.freeze({ ...context.metadata }) } : {}),
        })
      : undefined,
    active: true,
  };
  return scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      // Timers belonging to a completed request cannot reuse its attribution.
      scope.active = false;
    }
  });
}
