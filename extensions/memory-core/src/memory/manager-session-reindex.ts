export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  dirtySessionTranscriptCount: number;
  sync?: {
    reason?: string;
    force?: boolean;
    sessionTranscripts?: string[];
  };
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
  if (
    params.sync?.sessionTranscripts?.some(
      (sessionTranscript) => sessionTranscript.trim().length > 0,
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
