/** Resolve the process-tool isolation key for exec/process session state. */
export function resolveProcessToolScopeKey(params: {
  scopeKey?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): string | undefined {
  const scopeKey = params.scopeKey?.trim() || params.sessionKey?.trim() || params.sessionId?.trim();
  if (scopeKey) {
    return scopeKey;
  }
  const agentId = params.agentId?.trim();
  return agentId ? `agent:${agentId}` : undefined;
}
