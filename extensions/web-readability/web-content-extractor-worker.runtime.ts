import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
} from "openclaw/plugin-sdk/process-runtime";
import type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
} from "openclaw/plugin-sdk/web-content-extractor";

const pool = new WorkerTaskPool<WebContentExtractionRequest, WebContentExtractionResult | null>({
  workerUrl: resolveRuntimeWorkerUrl(
    createPluginRuntimeProcessEntrypoint("webReadability", import.meta.url),
  ),
  workerClass: "compute",
  sharedCompute: true,
});

export function extractInWorker(request: WebContentExtractionRequest) {
  // Cancellation belongs to web-fetch: admitted extraction finishes within the existing
  // HTML caps and its late result is discarded. Rare aborts do not terminate a worker.
  return pool.run(request, { inputBytes: request.html.length * 2 });
}
