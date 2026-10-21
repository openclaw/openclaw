import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServerRequestContext } from "../plugins/types.mcp-connection.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Metadata = Readonly<Record<string, string>>;
type RequestScope = {
  context: McpServerRequestContext | undefined;
  metadata: Metadata | undefined;
  active: boolean;
};
type RunAuthority = { active: boolean };

const scopes = resolveGlobalSingleton<AsyncLocalStorage<RequestScope>>(
  Symbol.for("openclaw.mcpRequestContext"),
  () => new AsyncLocalStorage(),
);
// Only contexts issued by bindMcpRequestRun carry identity, and only until that run settles.
const authorities = resolveGlobalSingleton<WeakMap<McpServerRequestContext, RunAuthority>>(
  Symbol.for("openclaw.mcpRequestRunAuthority"),
  () => new WeakMap(),
);

function currentScope(): RequestScope | undefined {
  const scope = scopes.getStore();
  return scope?.active ? scope : undefined;
}

function freeze(metadata: Metadata | undefined): Metadata | undefined {
  return metadata ? Object.freeze({ ...metadata }) : undefined;
}

async function enter<T>(
  context: McpServerRequestContext | undefined,
  metadata: Metadata | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const scope: RequestScope = { context, metadata, active: true };
  return scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      // Timers belonging to a completed request cannot reuse its attribution.
      scope.active = false;
    }
  });
}

export function getMcpRequestContext(): McpServerRequestContext | undefined {
  const context = currentScope()?.context;
  return context && authorities.get(context)?.active ? context : undefined;
}

/**
 * Host-only: attribute MCP requests to an admitted run until `run` settles. Without explicit
 * metadata, the enclosing caller's metadata is kept; identity always comes from the host.
 */
export async function bindMcpRequestRun<T>(
  identity: McpServerRequestContext,
  run: () => T | Promise<T>,
): Promise<T> {
  const metadata = freeze(identity.metadata ?? currentScope()?.metadata);
  const context: McpServerRequestContext = Object.freeze({
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
    runId: identity.runId,
    ...(metadata ? { metadata } : {}),
  });
  const authority: RunAuthority = { active: true };
  authorities.set(context, authority);
  try {
    return await enter(context, metadata, run);
  } finally {
    authority.active = false;
  }
}

/** Re-enter a host-issued run context. Undefined, or any context the host did not issue, clears it. */
export function runWithMcpRequestContext<T>(
  context: McpServerRequestContext | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const issued = context && authorities.has(context) ? context : undefined;
  return enter(issued, issued?.metadata, run);
}

/** Caller tracing metadata for MCP requests made inside `run`; never carries run identity. */
export function runWithMcpRequestMetadata<T>(
  metadata: Metadata,
  run: () => T | Promise<T>,
): Promise<T> {
  const frozen = freeze(metadata);
  const context = getMcpRequestContext();
  const authority = context && authorities.get(context);
  if (!context || !authority) {
    return enter(undefined, frozen, run);
  }
  const derived: McpServerRequestContext = Object.freeze({ ...context, metadata: frozen });
  authorities.set(derived, authority);
  return enter(derived, frozen, run);
}
