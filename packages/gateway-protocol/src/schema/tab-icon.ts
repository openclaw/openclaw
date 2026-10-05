import { USER_PREFS_VALUE_BYTES } from "./user-profile-constants.js";

export type TabIconPreference = {
  mode: "default" | "agent" | "custom";
  image?: { dataUrl: string; fileName: string };
};

export const TAB_ICON_FILE_NAME_MAX_LENGTH = 128;
const RASTER_DATA_URL =
  /^data:image\/(png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRasterDataUrl(value: string): boolean {
  const match = RASTER_DATA_URL.exec(value);
  const payload = match?.[2];
  if (!match || !payload) {
    return false;
  }
  const bytes = atob(payload);
  // MIME and magic bytes must agree. The upload owner decodes and rasterizes
  // inputs; persisted values never point at remote resources or SVG documents.
  return match[1] === "png"
    ? bytes.length >= 33 && bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.slice(12, 16) === "IHDR"
    : bytes.length >= 20 &&
        bytes.startsWith("RIFF") &&
        bytes.slice(8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16));
}

/** One bounded profile value, including a retained upload in every mode. */
export function normalizeTabIconPreference(value: unknown): TabIconPreference | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "mode" && key !== "image") ||
    !Object.hasOwn(value, "mode") ||
    (value.mode !== "default" && value.mode !== "agent" && value.mode !== "custom")
  ) {
    return undefined;
  }
  const result: TabIconPreference = { mode: value.mode };
  if (Object.hasOwn(value, "image")) {
    const image = value.image;
    if (
      !isRecord(image) ||
      Object.keys(image).length !== 2 ||
      !Object.hasOwn(image, "dataUrl") ||
      !Object.hasOwn(image, "fileName") ||
      typeof image.dataUrl !== "string" ||
      image.dataUrl.length > USER_PREFS_VALUE_BYTES ||
      typeof image.fileName !== "string" ||
      image.fileName.length === 0 ||
      image.fileName.length > TAB_ICON_FILE_NAME_MAX_LENGTH ||
      !image.fileName.trim() ||
      /[\u0000-\u001f\u007f]/.test(image.fileName)
    ) {
      return undefined;
    }
    result.image = { dataUrl: image.dataUrl, fileName: image.fileName };
  }
  if (encoder.encode(JSON.stringify(result)).byteLength > USER_PREFS_VALUE_BYTES) {
    return undefined;
  }
  return result.image && !isRasterDataUrl(result.image.dataUrl) ? undefined : result;
}
