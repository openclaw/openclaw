import type { Session } from "node:inspector/promises";

// Keep the caller's await and lifetime; return the original Inspector promise.
export function startCollectedHeapSampling(session: Session, samplingInterval: number) {
  session.connect();
  return session.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
