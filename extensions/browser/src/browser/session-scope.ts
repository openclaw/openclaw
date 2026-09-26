import { z } from "zod";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";

export const browserSessionScopeSchema = z.object({
  sessionKey: z.string().trim().min(1),
  sessionId: z.string().min(1),
  lifecycleRevision: z.string().min(1).optional(),
});
export type BrowserSessionScope = z.infer<typeof browserSessionScopeSchema>;

/** Session identity narrows the existing browser capability; it never grants profile access. */
export async function prepareBrowserSessionScope(sessionKey: string) {
  const runtime = getBrowserStateRuntime();
  const capture = runtime.gateway?.captureSessionLifetime;
  if (!capture) {
    throw new Error("Gateway session lifetime capability is unavailable");
  }
  const lifetime = await capture(sessionKey);
  const assertCurrent = () => {
    lifetime.assertCurrent();
    if (getBrowserStateRuntime() !== runtime) {
      throw new Error("Browser session runtime changed");
    }
  };
  assertCurrent();
  return {
    session: {
      sessionKey: lifetime.target.sessionKey,
      sessionId: lifetime.target.sessionId,
      ...(lifetime.target.lifecycleRevision
        ? { lifecycleRevision: lifetime.target.lifecycleRevision }
        : {}),
    },
    assertCurrent,
    retainSession: lifetime.retain,
  };
}

/** Standalone tools use the same persisted identity, never an invented revision or run ID. */
export async function prepareStandaloneBrowserSessionScope(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  sessionStore?: string;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const runtime = getBrowserStateRuntime();
  const getSessionEntryAsync = runtime.getSessionEntryAsync;
  if (!getSessionEntryAsync) {
    throw new Error("Asynchronous session entry capability is unavailable");
  }
  const [{ resolveStorePath }, { parseAgentSessionKey }] = await Promise.all([
    import("openclaw/plugin-sdk/session-store-paths"),
    import("openclaw/plugin-sdk/routing"),
  ]);
  params.assertCurrent();
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Standalone browser session identity requires an agent ID");
  }
  const entry = await getSessionEntryAsync({
    agentId,
    sessionKey: params.sessionKey,
    storePath: resolveStorePath(params.sessionStore, { agentId }),
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (!entry || entry.sessionId !== params.sessionId) {
    throw new Error("Browser tool invocation belongs to a replaced session");
  }
  return {
    session: {
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
      ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    },
    assertCurrent: params.assertCurrent,
  };
}

// Older node hosts reject this unknown path before executing any browser effect.
const SESSION_PROXY_PREFIX = "/__openclaw/session-tabs/v1/";
export function encodeBrowserSessionPath(path: string, scope: BrowserSessionScope): string {
  return (
    SESSION_PROXY_PREFIX +
    encodeURIComponent(scope.sessionKey) +
    "/" +
    encodeURIComponent(scope.sessionId) +
    "/" +
    encodeURIComponent(JSON.stringify(scope.lifecycleRevision ?? null)) +
    path
  );
}
export function decodeBrowserSessionPath(path: string): {
  path: string;
  session?: BrowserSessionScope;
} {
  if (!path.startsWith(SESSION_PROXY_PREFIX)) {
    return { path };
  }
  const [key, id, revision, ...parts] = path.slice(SESSION_PROXY_PREFIX.length).split("/");
  const lifecycleRevision: unknown = JSON.parse(decodeURIComponent(revision ?? ""));
  const session = browserSessionScopeSchema.parse({
    sessionKey: decodeURIComponent(key ?? ""),
    sessionId: decodeURIComponent(id ?? ""),
    ...(lifecycleRevision !== null ? { lifecycleRevision } : {}),
  });
  return { path: "/" + parts.join("/"), session };
}
