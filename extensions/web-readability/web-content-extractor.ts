import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebContentExtractorPlugin } from "openclaw/plugin-sdk/web-content-extractor";

const loadWorker = createLazyRuntimeModule(
  () => import("./web-content-extractor-worker.runtime.js"),
);

export function createReadabilityWebContentExtractor(): WebContentExtractorPlugin {
  return {
    id: "readability",
    label: "Readability",
    autoDetectOrder: 10,
    extract: async (request) => (await loadWorker()).extractInWorker(request),
  };
}
