import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "openclaw/plugin-sdk/document-extractor";
import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import { extractPdfContent } from "./document-extractor.runtime.js";

export type DocumentExtractorWorkerRequest = Omit<
  DocumentExtractionRequest,
  "signal" | "onImageExtractionError"
>;
export type DocumentExtractorWorkerReply = { imageErrors: Error[] } & (
  | { status: "ok"; result: DocumentExtractionResult }
  | { status: "failed"; error: Error }
);

serveWorkerTasks<DocumentExtractorWorkerReply>(async (input) => {
  // SAFETY: The plugin-owned pool sends this private request shape; both sides are built together.
  const request = input as DocumentExtractorWorkerRequest;
  const imageErrors: Error[] = [];
  try {
    const result = await extractPdfContent({
      ...request,
      onImageExtractionError: (error) =>
        imageErrors.push(error instanceof Error ? error : new Error(String(error))),
    });
    return { status: "ok", result, imageErrors };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
      imageErrors,
    };
  }
});
