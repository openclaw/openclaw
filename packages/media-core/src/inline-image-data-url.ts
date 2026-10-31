import { canonicalizeBase64 } from "./base64.js";

/** Prefix used to distinguish inline data URLs from remote/local image references. */
export const INLINE_IMAGE_DATA_URL_PREFIX = "data:";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heis", "heim", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const IMAGE_SIGNATURE_PREFIX_BASE64_CHARS = 128;
const INLINE_IMAGE_DATA_URL_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Sniffs supported inline image formats from decoded bytes. */
export function sniffInlineImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.readBigUInt64BE(0) === 0x89504e470d0a1a0an) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.readUIntBE(0, 3) === 0xffd8ff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (buffer.length >= 2 && buffer.readUInt16BE(0) === 0x424d) {
    return "image/bmp";
  }
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    return undefined;
  }
  const brands = [buffer.subarray(8, 12).toString("ascii")];
  for (let offset = 16; offset + 4 <= buffer.length; offset += 4) {
    brands.push(buffer.subarray(offset, offset + 4).toString("ascii"));
  }
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) {
    return "image/heic";
  }
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) {
    return "image/heif";
  }
  return undefined;
}

export type SanitizedInlineImageBase64 = {
  mimeType: string;
  base64: string;
};

/** Canonicalizes trusted inline image base64 and rejects malformed or non-image payloads. */
export function sanitizeInlineImageBase64(params: {
  mimeType: string;
  base64: string;
}): SanitizedInlineImageBase64 | undefined {
  if (!params.mimeType.trim().toLowerCase().startsWith("image/")) {
    return undefined;
  }
  const canonicalPayload = canonicalizeBase64(params.base64);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffInlineImageMime(
    Buffer.from(canonicalPayload.slice(0, IMAGE_SIGNATURE_PREFIX_BASE64_CHARS), "base64"),
  );
  if (!sniffedMimeType) {
    return undefined;
  }
  return {
    mimeType: sniffedMimeType,
    base64: canonicalPayload,
  };
}

function sanitizeInlineImageDataUrlWithAllowedMimes(
  imageUrl: string,
  allowedMimes?: Set<string>,
): string | undefined {
  if (
    imageUrl.slice(0, INLINE_IMAGE_DATA_URL_PREFIX.length).toLowerCase() !==
    INLINE_IMAGE_DATA_URL_PREFIX
  ) {
    return imageUrl;
  }
  const commaIndex = imageUrl.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const [mimeType, ...options] = imageUrl
    .slice(INLINE_IMAGE_DATA_URL_PREFIX.length, commaIndex)
    .split(";")
    .map((part) => part.trim());
  if (!mimeType || !options.some((part) => part.toLowerCase() === "base64")) {
    return undefined;
  }
  const sanitized = sanitizeInlineImageBase64({
    mimeType,
    base64: imageUrl.slice(commaIndex + 1),
  });
  if (!sanitized) {
    return undefined;
  }
  if (allowedMimes && !allowedMimes.has(sanitized.mimeType)) {
    return undefined;
  }
  // Trust the byte signature over caller-supplied metadata before reinlining.
  return `data:${sanitized.mimeType};base64,${sanitized.base64}`;
}

/**
 * Canonicalizes trusted inline image data URLs for persistence.
 * Accepts every image signature supported by `sanitizeInlineImageBase64`.
 */
export function sanitizeInlineImageDataUrlForStorage(imageUrl: string): string | undefined {
  return sanitizeInlineImageDataUrlWithAllowedMimes(imageUrl);
}

/** Canonicalizes provider-safe inline image data URLs and rejects unsupported formats. */
export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeInlineImageDataUrlWithAllowedMimes(imageUrl, INLINE_IMAGE_DATA_URL_MIMES);
}
