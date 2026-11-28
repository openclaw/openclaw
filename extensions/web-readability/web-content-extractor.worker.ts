import type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
} from "openclaw/plugin-sdk/web-content-extractor";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import { extractReadabilityContent } from "./web-content-extractor.runtime.js";

serveWorkerTasks<WebContentExtractionResult | null, WebContentExtractionRequest>(
  extractReadabilityContent,
);
