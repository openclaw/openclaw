import type { HeapProfiler, Session } from "node:inspector/promises";

// Keep the caller's await and lifetime; return the original Inspector promise.
export function startCollectedHeapSampling(session: Session, samplingInterval: number) {
  session.connect();
  return session.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}

export function sumSampledHeapBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sumSampledHeapBytes(child), 0);
}
