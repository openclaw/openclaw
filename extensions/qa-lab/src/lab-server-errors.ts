import type { IncomingMessage } from "node:http";
import {
  isQaMalformedJsonBodyError,
  writeError,
  writeQaRequestBodyLimitError,
} from "./bus-server.js";
import { QaEvidenceGalleryError } from "./evidence-gallery.js";

export class QaLabRunUnavailableError extends Error {
  constructor(
    readonly statusCode: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export async function writeQaLabServerError(
  req: IncomingMessage,
  res: Parameters<typeof writeError>[0],
  error: unknown,
): Promise<void> {
  if (await writeQaRequestBodyLimitError(req, res, error)) {
    return;
  }
  if (isQaMalformedJsonBodyError(error)) {
    writeError(res, 400, error.message);
    return;
  }
  if (error instanceof QaEvidenceGalleryError || error instanceof QaLabRunUnavailableError) {
    writeError(res, error.statusCode, error.message);
    return;
  }
  writeError(res, 500, error);
}
