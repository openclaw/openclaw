import { MEMORY_INDEX_TABLE_NAMES } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

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
  const errDetail = params.loadError ? `: ${params.loadError}` : "";
  params.warn(
    `${MEMORY_INDEX_TABLE_NAMES.vector} not updated — sqlite-vec unavailable${errDetail}. Vector recall degraded. Further duplicate warnings suppressed.`,
  );
  return true;
}
