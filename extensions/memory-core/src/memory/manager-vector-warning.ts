// Memory Core plugin module implements manager vector warning behavior.
export function formatMemoryVectorDegradedWriteReason(loadError?: string): string {
  return loadError
    ? `sqlite-vec unavailable: ${loadError}`
    : "semantic vector embeddings unavailable — no vector dimensions resolved";
}

export function logMemoryVectorDegradedWrite(params: {
  vectorEnabled: boolean;
  vectorReady: boolean;
  chunkCount: number;
  warningShown: boolean;
  loadError?: string;
  warn: (message: string) => void;
}): boolean {
  if (
    !params.vectorEnabled ||
    params.vectorReady ||
    params.chunkCount <= 0 ||
    params.warningShown
  ) {
    return params.warningShown;
  }
  params.warn(
<<<<<<< HEAD
    `memory_index_chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(params.loadError)}. Vector recall degraded. Further duplicate warnings suppressed.`,
=======
    `chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(params.loadError)}. Vector recall degraded. Further duplicate warnings suppressed.`,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
  return true;
}
