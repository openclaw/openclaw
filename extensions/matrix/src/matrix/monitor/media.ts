import { getMatrixRuntime } from "../../runtime.js";
import { MatrixMediaSizeLimitError, isMatrixMediaSizeLimitError } from "../media-errors.js";
import type { EncryptedFile, MatrixClient } from "../sdk.js";

const MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  sizeBytes?: number;
  maxBytes: number;
  file?: EncryptedFile;
  originalFilename?: string;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
}> {
  if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {
    throw new MatrixMediaSizeLimitError();
  }

  const options = {
    maxBytes: params.maxBytes,
    readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
  };
  let buffer: Buffer;
  if (params.file) {
    if (!params.client.crypto) {
      throw new Error("Cannot decrypt media: crypto not enabled");
    }
    buffer = await params.client.crypto.decryptMedia(params.file, options);
    if (buffer.byteLength > params.maxBytes) {
      throw new MatrixMediaSizeLimitError();
    }
  } else {
    try {
      buffer = await params.client.downloadContent(params.mxcUrl, options);
    } catch (err) {
      if (isMatrixMediaSizeLimitError(err)) {
        throw err;
      }
      throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
    }
  }

  const saved = await getMatrixRuntime().channel.media.saveMediaBuffer(
    buffer,
    params.contentType,
    "inbound",
    params.maxBytes,
    params.originalFilename,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]",
  };
}
