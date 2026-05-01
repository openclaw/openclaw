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
  let reason: string;
  if (params.loadError) {
    reason = `sqlite-vec unavailable: ${params.loadError}`;
  } else {
    reason = "embedding provider unavailable — no vector dimensions resolved";
  }
  params.warn(
    `chunks_vec not updated — ${reason}. Vector recall degraded. Further duplicate warnings suppressed.`,
  );
  return true;
}
