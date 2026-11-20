import { randomUUID } from "node:crypto";
import { sniffImageMimeType } from "openclaw/plugin-sdk/image-generation";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

export const PIXVERSE_INPUT_PROFILE = "clawrouter.pixverse-image-input.v1";
export const PIXVERSE_IMAGE_PATH = "/openapi/v2/video/img/generate";
const MODELS = new Set(["pixverse/v6", "pixverse/c1"]);
const QUALITIES = ["360p", "540p", "720p", "1080p"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const OPTIONS = new Set([
  "quality",
  "seed",
  "negative_prompt",
  "camera_movement",
  "template_id",
  "motion_mode",
]);

export const PIXVERSE_VIDEO_CAPABILITIES: VideoGenerationProvider["capabilities"] = {
  imageToVideo: {
    enabled: true,
    maxInputImages: 1,
    maxInputVideos: 0,
    maxInputAudios: 0,
    maxDurationSeconds: 15,
    supportsResolution: true,
    resolutions: QUALITIES,
    supportsAudio: true,
  },
  providerOptions: {
    quality: "string",
    seed: "number",
    negative_prompt: "string",
    camera_movement: "string",
    template_id: "number",
    motion_mode: "string",
  },
};

export function isPixVerseImageOffer(offer: ClawRouterCapabilityOffer, model: string): boolean {
  return (
    MODELS.has(model) &&
    offer.providerId === "pixverse" &&
    offer.endpoint === "image_video" &&
    offer.path === PIXVERSE_IMAGE_PATH &&
    offer.routeKind === "native" &&
    offer.methods.includes("POST") &&
    offer.inputProfile === PIXVERSE_INPUT_PROFILE &&
    offer.requestFormat === "pixverse.image_video" &&
    offer.responseFormat === "pixverse.video" &&
    offer.model?.id === model &&
    offer.model.upstream === model.slice("pixverse/".length) &&
    Array.isArray(offer.model.capabilities) &&
    offer.model.capabilities.includes("video.generate")
  );
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    Buffer.byteLength(value) > maximum
  ) {
    throw new Error("ClawRouter PixVerse text exceeds the selected input profile.");
  }
  return value;
}

/** Snapshot the bounded caller-owned bytes before discovery or any paid dispatch. */
export function preparePixVerseMultipart(req: VideoGenerationRequest) {
  const image = req.inputImages?.[0];
  if (
    !MODELS.has(req.model) ||
    req.inputImages?.length !== 1 ||
    !image?.buffer?.length ||
    image.buffer.length > MAX_IMAGE_BYTES ||
    image.url !== undefined ||
    image.metadata !== undefined ||
    (image.role !== undefined &&
      image.role !== "first_frame" &&
      image.role !== "reference_image") ||
    req.inputVideos?.length ||
    req.inputAudios?.length
  ) {
    throw new Error(
      "ClawRouter PixVerse requires one local PNG, JPEG or WebP image of at most 8 MiB and model pixverse/v6 or pixverse/c1.",
    );
  }
  const mime = sniffImageMimeType(image.buffer, "").mimeType;
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || image.mimeType !== mime) {
    throw new Error(
      "ClawRouter PixVerse image bytes must match their PNG, JPEG or WebP MIME type.",
    );
  }
  if (req.size !== undefined || req.aspectRatio !== undefined || req.watermark !== undefined) {
    throw new Error(
      "ClawRouter PixVerse image intake does not accept size, aspect ratio or watermark overrides.",
    );
  }
  const options = req.providerOptions ?? {};
  if (Object.keys(options).some((key) => !OPTIONS.has(key))) {
    throw new Error(
      "Unsupported ClawRouter PixVerse option; caller image IDs, URLs, receipts and grants are not accepted.",
    );
  }
  const duration = req.durationSeconds ?? 5;
  const quality = options.quality ?? req.resolution?.toLowerCase() ?? "540p";
  if (
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 15 ||
    typeof quality !== "string" ||
    !QUALITIES.includes(quality) ||
    (options.quality !== undefined &&
      req.resolution !== undefined &&
      quality !== req.resolution.toLowerCase())
  ) {
    throw new Error(
      "ClawRouter PixVerse requires an integer duration of 1–15 seconds and a supported quality.",
    );
  }
  const fields: Record<string, string> = {
    model: req.model.slice("pixverse/".length),
    prompt: boundedText(req.prompt, 2048),
    duration: String(duration),
    quality,
  };
  for (const [key, maximum] of [
    ["negative_prompt", 2048],
    ["camera_movement", 128],
    ["motion_mode", 64],
  ] as const) {
    if (options[key] !== undefined) {
      fields[key] = boundedText(options[key], maximum, key === "negative_prompt");
    }
  }
  for (const [key, maximum] of [
    ["seed", 2147483647],
    ["template_id", Number.MAX_SAFE_INTEGER],
  ] as const) {
    const value = options[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error("ClawRouter PixVerse numeric control is outside the input profile.");
    }
    fields[key] = String(value);
  }
  if (req.audio !== undefined) {
    if (typeof req.audio !== "boolean") {
      throw new Error("ClawRouter PixVerse audio must be boolean.");
    }
    fields.generate_audio_switch = String(req.audio);
  }
  const key = randomUUID();
  const boundary = "openclaw-pixverse-" + key;
  const prefix =
    Object.entries(fields)
      .map(([name, value]) => {
        if (value.includes(boundary)) {
          throw new Error("ClawRouter PixVerse multipart boundary collision.");
        }
        return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      })
      .join("") +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  if (Buffer.byteLength(prefix) + Buffer.byteLength(suffix) > MAX_ENVELOPE_BYTES) {
    throw new Error("ClawRouter PixVerse multipart envelope exceeds 32 KiB.");
  }
  return {
    body: Buffer.concat([Buffer.from(prefix), image.buffer, Buffer.from(suffix)]),
    contentType: "multipart/form-data; boundary=" + boundary,
    idempotencyKey: key,
  };
}

export function readPixVerseId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  ) {
    return value;
  }
  throw new Error("ClawRouter PixVerse returned an invalid original video identity.");
}

export function readPixVerseEnvelope(payload: unknown): Record<string, unknown> {
  const body = asOptionalRecord(payload);
  const result = asOptionalRecord(body?.Resp);
  if (body?.ErrCode !== 0 || !result) {
    throw new Error("ClawRouter PixVerse returned an invalid response envelope.");
  }
  return result;
}

export function readPixVerseStatus(payload: unknown, id: string) {
  const result = readPixVerseEnvelope(payload);
  for (const name of ["id", "video_id"]) {
    if (result[name] !== undefined && readPixVerseId(result[name]) !== id) {
      throw new Error("ClawRouter PixVerse returned a different video identity.");
    }
  }
  if (typeof result.status !== "number" || ![1, 5, 6, 7, 8].includes(result.status)) {
    throw new Error("ClawRouter PixVerse returned an invalid video status.");
  }
  if (result.status === 6) {
    throw new Error("ClawRouter PixVerse original video observation is unavailable.");
  }
  if (result.status === 7 || result.status === 8) {
    throw new Error("ClawRouter PixVerse video generation failed.");
  }
  if (
    result.status === 1 &&
    (typeof result.url !== "string" || !result.url.trim() || result.url.length > 8192)
  ) {
    throw new Error("ClawRouter PixVerse completed video URL is missing or malformed.");
  }
  return { complete: result.status === 1, url: result.url as string | undefined };
}
