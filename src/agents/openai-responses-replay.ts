export function resolveReplayableResponsesMessageId(params: {
  replayResponsesItemIds: boolean;
  textSignatureId?: string;
  textSignaturePhase?: "commentary" | "final_answer";
  fallbackId: string;
  fallbackOrdinal: number;
  previousReplayItemWasReasoning: boolean;
}): string | undefined {
  if (!params.replayResponsesItemIds) {
    return undefined;
  }
  if (!params.textSignatureId) {
    return params.fallbackOrdinal === 0
      ? params.fallbackId
      : `${params.fallbackId}_${params.fallbackOrdinal}`;
  }
  if (params.textSignaturePhase) {
    return params.textSignatureId;
  }
  return params.previousReplayItemWasReasoning ? params.textSignatureId : undefined;
}
