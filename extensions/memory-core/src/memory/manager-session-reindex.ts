export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  dirtySessionTranscriptCount: number;
  sync?: {
    reason?: string;
    force?: boolean;
    sessionTranscriptScopes?: Array<{ agentId: string; sessionId: string }>;
  };
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
  if (
    params.sync?.sessionTranscriptScopes?.some(
      (scope) => scope.agentId.trim().length > 0 && scope.sessionId.trim().length > 0,
    )
  ) {
    return true;
  }
  if (params.sync?.force) {
    return true;
  }
  if (params.needsFullReindex) {
    return true;
  }
  const reason = params.sync?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return params.sessionsDirty && params.dirtySessionTranscriptCount > 0;
}
