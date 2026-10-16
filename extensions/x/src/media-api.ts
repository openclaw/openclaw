import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { XAssertActive } from "./fetch.js";

// https://docs.x.com/x-api/media/quickstart/media-upload-chunked
// Stay below X's recommended 5 MB segment size, including multipart overhead.
const CHUNK_BYTES = 4 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 5 * 60_000;

export type XMediaUploadParams = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
  mediaCategory: "tweet_image" | "tweet_gif" | "tweet_video";
  signal?: AbortSignal;
  assertActive?: XAssertActive;
};

type MediaRequest = (
  path: string,
  params: {
    method: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    assertActive?: XAssertActive;
  },
) => Promise<Response>;

function mediaError(message: string, retryable = false) {
  return new PlatformMessageNotDispatchedError(message, { cause: undefined, retryable });
}

async function readUploadResponse(response: Response, allowEmpty = false) {
  const text = await response.text();
  if (allowEmpty && !text.trim()) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw mediaError("X media upload returned an unreadable response; no Post was created");
  }
  const row = record(value);
  if (!row || (Array.isArray(row.errors) && row.errors.length)) {
    throw mediaError("X media upload was not accepted; no Post was created");
  }
  return record(row.data);
}

export async function uploadXMedia(
  params: XMediaUploadParams,
  request: MediaRequest,
): Promise<string> {
  const send = (path: string, method: "GET" | "POST", body?: unknown) =>
    request(path, { method, body, signal: params.signal, assertActive: params.assertActive });
  const initialized = await readUploadResponse(
    await send("/2/media/upload/initialize", "POST", {
      media_type: params.contentType,
      total_bytes: params.buffer.length,
      media_category: params.mediaCategory,
    }),
  );
  const mediaId = initialized?.id;
  if (typeof mediaId !== "string" || !/^[0-9]{1,19}$/.test(mediaId)) {
    throw mediaError("X media upload returned no valid media ID; no Post was created");
  }
  const path = "/2/media/upload/" + mediaId;
  for (
    let offset = 0, segment = 0;
    offset < params.buffer.length;
    offset += CHUNK_BYTES, segment++
  ) {
    params.signal?.throwIfAborted();
    const body = new FormData();
    body.set("segment_index", String(segment));
    body.set(
      "media",
      new Blob([bufferToBlobPart(params.buffer.subarray(offset, offset + CHUNK_BYTES))], {
        type: params.contentType,
      }),
      params.fileName,
    );
    await readUploadResponse(await send(path + "/append", "POST", body), true);
  }
  let data = await readUploadResponse(await send(path + "/finalize", "POST"));
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  let polling = false;
  for (;;) {
    params.signal?.throwIfAborted();
    if (data?.id !== mediaId) {
      throw mediaError("X media upload returned an invalid media result; no Post was created");
    }
    // FINALIZE without processing_info means ready. Once processing starts,
    // only an explicit succeeded status permits the caller to create a Post.
    if (data.processing_info === undefined && !polling) {
      return mediaId;
    }
    const processing = record(data.processing_info);
    if (processing?.state === "succeeded") {
      return mediaId;
    }
    if (processing?.state === "failed") {
      throw mediaError(
        "X media processing failed; check the file format and encoding before retrying",
      );
    }
    if (processing?.state !== "pending" && processing?.state !== "in_progress") {
      throw mediaError("X media upload returned an invalid processing state; no Post was created");
    }
    const seconds = processing.check_after_secs;
    const delay =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.max(1, seconds) * 1000
        : 1000;
    // Never poll earlier than X requests. Stop rather than shortening a server
    // delay that exceeds our bounded processing wait.
    if (Date.now() + delay >= deadline) {
      throw mediaError("X media processing timed out before posting; try again later", true);
    }
    await sleepWithAbort(delay, params.signal);
    params.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw mediaError("X media processing timed out before posting; try again later", true);
    }
    data = await readUploadResponse(
      await send("/2/media/upload?command=STATUS&media_id=" + mediaId, "GET"),
    );
    polling = true;
  }
}
