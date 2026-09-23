// Qualified keys already carry their source agent. Keep the unqualified global
// sentinel distinct from a literal agent:<id>:global session without extending v1.
export function sessionShareThreadId(agentId: string, sessionKey: string): string {
  return sessionKey === "global" ? `session-share:${agentId}:global` : sessionKey;
}

export function sessionShareSourceSession(threadId: string) {
  const global = /^session-share:([^:]+):global$/.exec(threadId);
  return global ? { sessionKey: "global", fallbackAgentId: global[1] } : { sessionKey: threadId };
}
