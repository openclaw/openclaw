/**
 * Upload an image from a URL to Tlon storage.
 */
import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { uploadFile } from "../tlon-api.js";

const TLON_UPLOAD_IMAGE_IDLE_TIMEOUT_MS = 30_000;
const TLON_UPLOAD_IMAGE_RESPONSE_HEADER_TIMEOUT_MS = 120_000;

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Returns the uploaded URL, or falls back to the original URL on error.
 *
 * Note: configureClient must be called before using this function.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    // Validate URL is http/https before fetching
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
      return imageUrl;
    }

    const fetched = await readRemoteMediaBuffer({
      url: imageUrl,
      maxBytes: MAX_IMAGE_BYTES,
      responseHeaderTimeoutMs: TLON_UPLOAD_IMAGE_RESPONSE_HEADER_TIMEOUT_MS,
      readIdleTimeoutMs: TLON_UPLOAD_IMAGE_IDLE_TIMEOUT_MS,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });

    const contentType = fetched.contentType || "image/png";
    const blob = new Blob([new Uint8Array(fetched.buffer)], { type: contentType });

    // Extract filename from URL or use a default
    const urlPath = new URL(imageUrl).pathname;
    const fileName = urlPath.split("/").pop() || `upload-${Date.now()}.png`;

    // Upload to Tlon storage
    const result = await uploadFile({
      blob,
      fileName,
      contentType,
    });

    return result.url;
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${String(err)}`);
    return imageUrl;
  }
}
