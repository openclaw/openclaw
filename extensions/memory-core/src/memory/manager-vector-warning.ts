export function logMemoryVectorDegradedWrite(params: {
  vectorEnabled: boolean;
  vectorReady: boolean;
  chunkCount: number;
  warningShown: boolean;
  path: string;
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
  const errDetail = params.loadError ? `: ${params.loadError}` : "";
  params.warn(
    `chunks written for ${params.path} without vector embeddings — chunks_vec not updated (sqlite-vec unavailable${errDetail}). Vector recall degraded; suppressing duplicate per-file warnings for this manager.`,
  );
  return true;
}
