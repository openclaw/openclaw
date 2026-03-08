export type CaMeLScopeContext = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
};

export const activeCaMeLOrchestratorScopes = new Set<string>();

export function resolveCaMeLScopeKey(ctx?: CaMeLScopeContext): string {
  const runId = ctx?.runId?.trim();
  if (runId) {
    return `run:${runId}`;
  }
  const sessionId = ctx?.sessionId?.trim();
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const sessionKey = ctx?.sessionKey?.trim();
  if (sessionKey) {
    return `sessionKey:${sessionKey}`;
  }
  const agentId = ctx?.agentId?.trim();
  if (agentId) {
    return `agent:${agentId}`;
  }
  return "global";
}
