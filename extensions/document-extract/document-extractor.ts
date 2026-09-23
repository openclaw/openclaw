import type { DocumentExtractorPlugin } from "openclaw/plugin-sdk/document-extractor";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { documentExtractorWorkerEntrypoint } from "./document-extractor-worker-entrypoint.js";
import type {
  DocumentExtractorWorkerReply,
  DocumentExtractorWorkerRequest,
} from "./document-extractor.worker.js";

const pool = new WorkerTaskPool<DocumentExtractorWorkerRequest, DocumentExtractorWorkerReply>({
  workerUrl: resolveRuntimeWorkerUrl(documentExtractorWorkerEntrypoint),
  // One reusable PDFium heap bounds simultaneous document rendering memory.
  maxWorkers: 1,
  sharedCompute: true,
});

export function createPdfDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: async ({ signal, onImageExtractionError, ...request }) => {
      const reply = await pool.run(request, {
        timeoutMs: 180_000,
        signal,
        inputBytes: request.buffer.byteLength,
      });
      signal?.throwIfAborted();
      for (const error of reply.imageErrors) {
        onImageExtractionError?.(error);
      }
      if (reply.status === "failed") {
        throw reply.error;
      }
      return reply.result;
    },
  };
}
