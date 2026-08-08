/**
 * Sanitizes inline image payloads mirrored through Codex history so invalid
 * base64 data becomes readable text instead of poisoning replayed transcripts.
 */
import {
  INLINE_IMAGE_DATA_URL_PREFIX,
  sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl,
} from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

/** Validates and normalizes an inline image data URL for Codex history payloads. */
export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeSharedInlineImageDataUrl(imageUrl);
}

/** Builds the replacement text inserted when an inline image payload is invalid. */
export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}

function sanitizeImageContentRecord(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  if (record.type === "image" && typeof record.data === "string") {
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "image/png";
    const imageUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${record.data}`);
    if (!imageUrl) {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const commaIndex = imageUrl.indexOf(",");
    const metadata = imageUrl.slice(INLINE_IMAGE_DATA_URL_PREFIX.length, commaIndex);
    const mime = metadata.split(";")[0] ?? mimeType;
    const data = imageUrl.slice(commaIndex + 1);
    return record.mimeType === mime && record.data === data
      ? record
      : { ...record, mimeType: mime, data };
  }

  if (record.type === "inputImage" && typeof record.imageUrl === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.imageUrl);
    if (!imageUrl) {
      return { type: "inputText", text: invalidInlineImageText(label) };
    }
    return imageUrl === record.imageUrl ? record : { ...record, imageUrl };
  }

  if (record.type === "input_image" && typeof record.image_url === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.image_url);
    if (!imageUrl) {
      return { type: "input_text", text: invalidInlineImageText(label) };
    }
    return imageUrl === record.image_url ? record : { ...record, image_url: imageUrl };
  }

  return undefined;
}

/** Recursively sanitizes all Codex history image shapes while preserving unknown structure. */
export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  if (Array.isArray(value)) {
    let next: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const sanitized = sanitizeCodexHistoryImagePayloads(entry, label);
      if (!Object.is(sanitized, entry)) {
        // Preserve every untouched branch by identity; only ancestors of an
        // actual image repair should allocate during long-history replay.
        next ??= value.slice();
        next[index] = sanitized;
      }
    }
    return (next ?? value) as T;
  }
  if (!isRecord(value)) {
    return value;
  }

  const imageRecord = sanitizeImageContentRecord(value, label);
  if (imageRecord) {
    return imageRecord as T;
  }

  let next: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const sanitized = sanitizeCodexHistoryImagePayloads(child, label);
    if (!Object.is(sanitized, child)) {
      next ??= { ...value };
      next[key] = sanitized;
    }
  }
  return (next ?? value) as T;
}
