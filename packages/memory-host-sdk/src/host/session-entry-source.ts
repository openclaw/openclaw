import { parseSqliteSessionFileMarker } from "./openclaw-runtime-session.js";

export function resolveBuildSessionSqliteIdentity(
  absPath: string,
  opts: { agentId?: string; sessionId?: string; sessionKey?: string; storePath?: string },
) {
  if (opts.agentId && opts.sessionId && opts.storePath) {
    return {
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      storePath: opts.storePath,
    };
  }
  const marker = parseSqliteSessionFileMarker(absPath);
  return marker && opts.sessionKey ? { ...marker, sessionKey: opts.sessionKey } : marker;
}
