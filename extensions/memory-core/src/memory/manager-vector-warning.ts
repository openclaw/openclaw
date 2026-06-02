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
    `chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(params.loadError)}. Vector recall degraded. Further duplicate warnings suppressed.`,
  );
  return true;
}

// Latched warn for the cross-encoder rerank stage: emit once on the transition
// into "degraded" so a failing reranker does not log per query. Returns the next
// latched state; callers pass `alreadyDegraded` and store the result.
export function logMemoryRerankDegraded(params: {
  alreadyDegraded: boolean;
  reason: string;
  warn: (message: string) => void;
}): boolean {
  if (params.alreadyDegraded) {
    return true;
  }
  params.warn(
    `memory rerank degraded — ${params.reason}. Falling back to pre-rerank order. Further duplicate warnings suppressed.`,
  );
  return true;
}
