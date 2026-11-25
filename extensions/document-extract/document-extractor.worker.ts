import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "openclaw/plugin-sdk/document-extractor";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import { extractPdfContent } from "./document-extractor.runtime.js";

export type DocumentExtractorWorkerRequest = Omit<
  DocumentExtractionRequest,
  "signal" | "onImageExtractionError"
>;
export type DocumentExtractorWorkerReply = { imageErrors: Error[] } & (
  | { status: "ok"; result: DocumentExtractionResult }
  | { status: "failed"; error: Error }
);

serveWorkerTasks<DocumentExtractorWorkerReply>(async (input, _progress, control) => {
  // SAFETY: The plugin-owned pool sends this private request shape; both sides are built together.
  const request = input as DocumentExtractorWorkerRequest;
  const imageErrors: Error[] = [];
  try {
    const result = await extractPdfContent(
      {
        ...request,
        onImageExtractionError: (error) => imageErrors.push(toStringifiedError(error)),
      },
      control,
    );
    return { status: "ok", result, imageErrors };
  } catch (error) {
    return {
      status: "failed",
      error: toStringifiedError(error),
      imageErrors,
    };
  }
});
