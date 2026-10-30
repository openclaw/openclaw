/**
 * Sanitizes OpenAI Responses payloads before transport. Invalid inline images
 * are replaced with text placeholders so the request remains valid and
 * auditable.
 */
import { sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl } from "@openclaw/media-core/inline-image-data-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInputImage } from "openai/resources/responses/responses.js";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

type ImageSource = { mimeType: string; data: string };
type ImagePayload = ImageSource & {
  sanitized?: false | { mimeType: string; normalizedUrl?: string };
};
const sourceImages = new WeakMap<ImageSource, ImagePayload>();
const inputImages = new WeakMap<object, { url: string; payload: ImagePayload }>();

/** Reuse scalar image work, never the mutable item exposed to payload hooks. */
export function buildResponsesInputImage(source: ImageSource): ResponseInputImage {
  const { mimeType, data } = source;
  let payload = sourceImages.get(source);
  if (!payload || payload.mimeType !== mimeType || payload.data !== data) {
    payload = { mimeType, data };
    sourceImages.set(source, payload);
  }
  const url = `data:${mimeType};base64,${data}`;
  const input: ResponseInputImage = { type: "input_image", detail: "auto", image_url: url };
  inputImages.set(input, { url, payload });
  return input;
}

function sanitizePreparedImage(payload: ImagePayload, url: string): string | undefined {
  if (payload.sanitized === undefined) {
    const normalizedUrl = sanitizeSharedInlineImageDataUrl(url);
    payload.sanitized = normalizedUrl
      ? {
          mimeType: normalizedUrl.slice(5, normalizedUrl.indexOf(";")),
          // Canonical data must not retain a second base64 copy through the source cache.
          ...(normalizedUrl.slice(normalizedUrl.indexOf(",") + 1) === payload.data
            ? {}
            : { normalizedUrl }),
        }
      : false;
  }
  const sanitized = payload.sanitized;
  return sanitized
    ? (sanitized.normalizedUrl ??
        (sanitized.mimeType === payload.mimeType
          ? url
          : `data:${sanitized.mimeType};base64,${payload.data}`))
    : undefined;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  if (value.type === "input_image" && typeof value.image_url === "string") {
    const url = value.image_url;
    const prepared = inputImages.get(value);
    // Source edits replace the fact; hook edits must cross sanitation again.
    const imageUrl =
      prepared?.url === url
        ? sanitizePreparedImage(prepared.payload, url)
        : sanitizeSharedInlineImageDataUrl(url);
    return imageUrl
      ? { ...value, image_url: imageUrl }
      : { type: "input_text", text: `[${IMAGE_OMITTED_TEXT}]` };
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = sanitizeValue(child);
  }
  return next;
}

/** Sanitize inline image fields inside a Responses API payload. */
export function sanitizeResponsesImagePayload<T extends Record<string, unknown>>(params: T): T {
  if (!Array.isArray(params.input)) {
    return params;
  }
  return {
    ...params,
    input: sanitizeValue(params.input),
  };
}
