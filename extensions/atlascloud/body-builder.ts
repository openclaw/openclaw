// extensions/atlascloud/body-builder.ts
// Schema-driven request body builder for the Atlas Cloud video generation
// provider. Kept in a separate file from the HTTP/auth runtime so it has
// ZERO runtime imports from the SDK and can be tested standalone (Node's
// `--experimental-strip-types` strips all `import type` statements).
import type {
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { resolveAtlasSchema } from "./model-schemas.js";

const DEFAULT_ATLASCLOUD_VIDEO_MODEL = "google/veo3.1-fast/text-to-video";

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function sourceAssetToDataString(asset: VideoGenerationSourceAsset): string | undefined {
  if (asset.url?.trim()) return asset.url.trim();
  if (asset.buffer) return toDataUrl(asset.buffer, asset.mimeType?.trim() || "image/png");
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Per-model / per-prefix passthrough parameters from
 * `models.providers.atlascloud.extraParams`. Exact keys override prefix keys
 * (longest prefix wins among prefixes).
 */
function resolveExtraParams(req: VideoGenerationRequest): Record<string, unknown> {
  const config = (req.cfg?.models?.providers as Record<string, unknown> | undefined)?.atlascloud;
  const extraMap = (
    config as { extraParams?: Record<string, Record<string, unknown>> } | undefined
  )?.extraParams;
  if (!extraMap || typeof extraMap !== "object") return {};
  const exact = extraMap[req.model];
  const prefixHit = Object.keys(extraMap)
    .filter((key) => key.endsWith("/") && req.model.startsWith(key))
    .toSorted((a, b) => b.length - a.length)[0];
  const prefix = prefixHit ? extraMap[prefixHit] : undefined;
  return { ...(prefix ?? {}), ...(exact ?? {}) };
}

export function buildAtlasCloudVideoBody(req: VideoGenerationRequest): Record<string, unknown> {
  const model = req.model?.trim() || DEFAULT_ATLASCLOUD_VIDEO_MODEL;
  const schema = resolveAtlasSchema(model);
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    ...(schema.defaults ?? {}),
  };

  // ---------------- 1. aspect_ratio ----------------
  if (schema.fields.aspectRatio && req.aspectRatio?.trim()) {
    const value = req.aspectRatio.trim();
    if (schema.options?.aspectRatios && !schema.options.aspectRatios.includes(value)) {
      throw new Error(
        `Atlas Cloud ${model} does not support aspect_ratio="${value}"; allowed: ${schema.options.aspectRatios.join(", ")}`,
      );
    }
    body[schema.fields.aspectRatio.name] = value;
  }

  // ---------------- 2. resolution ----------------
  if (schema.fields.resolution && req.resolution) {
    const raw = String(req.resolution);
    const value =
      schema.fields.resolution.case === "upper" ? raw.toUpperCase() : raw.toLowerCase();
    if (schema.options?.resolutions && !schema.options.resolutions.includes(value)) {
      throw new Error(
        `Atlas Cloud ${model} does not support resolution="${value}"; allowed: ${schema.options.resolutions.join(", ")}`,
      );
    }
    body[schema.fields.resolution.name] = value;
  }

  // ---------------- 3. size (auto-convert separator across families) ----------------
  if (schema.fields.size && req.size?.trim()) {
    const raw = req.size.trim();
    const sep = schema.fields.size.sep;
    const value = sep === "*" ? raw.replace(/x/i, "*") : raw.replace(/\*/g, "x");
    if (schema.options?.sizes && !schema.options.sizes.includes(value)) {
      throw new Error(
        `Atlas Cloud ${model} does not support size="${value}"; allowed: ${schema.options.sizes.join(", ")}`,
      );
    }
    body[schema.fields.size.name] = value;
  }

  // ---------------- 4. duration ----------------
  if (schema.fields.duration && isFiniteNumber(req.durationSeconds)) {
    const value = Math.max(1, Math.round(req.durationSeconds));
    if (schema.options?.durations && !schema.options.durations.includes(value)) {
      throw new Error(
        `Atlas Cloud ${model} does not support duration=${value}; allowed: ${schema.options.durations.join(", ")}`,
      );
    }
    body[schema.fields.duration.name] = value;
  }

  // ---------------- 5. audio (boolean only; URL audio uses extraParams) ----------------
  if (schema.fields.audio && typeof req.audio === "boolean") {
    if (schema.fields.audio.type === "boolean") {
      body[schema.fields.audio.name] = req.audio;
    }
  }

  // ---------------- 6. image / images ----------------
  const images = req.inputImages ?? [];
  if (schema.fields.image && images.length > 0) {
    if (schema.fields.image.multi) {
      const values = images
        .slice(0, schema.fields.image.max)
        .map(sourceAssetToDataString)
        .filter((v): v is string => Boolean(v));
      if (values.length > 0) body[schema.fields.image.name] = values;
    } else {
      const first = sourceAssetToDataString(images[0]);
      if (first) body[schema.fields.image.name] = first;
      if (schema.fields.endImage && images[1]) {
        const last = sourceAssetToDataString(images[1]);
        if (last) body[schema.fields.endImage.name] = last;
      }
    }
  }

  // ---------------- 7. video / videos ----------------
  const videos = req.inputVideos ?? [];
  if (schema.fields.video && videos.length > 0) {
    if (schema.fields.video.multi) {
      body[schema.fields.video.name] = videos
        .map(sourceAssetToDataString)
        .filter((v): v is string => Boolean(v));
    } else {
      const first = sourceAssetToDataString(videos[0]);
      if (first) body[schema.fields.video.name] = first;
    }
  }

  // ---------------- 8. mode-specific required-input checks ----------------
  switch (schema.mode) {
    case "image-to-video":
    case "start-end-frame":
      if (!body[schema.fields.image?.name ?? "image"]) {
        throw new Error(`Atlas Cloud ${model} (${schema.mode}) requires inputImages`);
      }
      break;
    case "video-to-video":
    case "video-edit":
      if (!body[schema.fields.video?.name ?? "videos"]) {
        throw new Error(`Atlas Cloud ${model} (${schema.mode}) requires inputVideos`);
      }
      break;
    case "reference-to-video":
      if (!Array.isArray(body[schema.fields.image?.name ?? "images"])) {
        throw new Error(
          `Atlas Cloud ${model} (reference-to-video) requires 1 to N inputImages`,
        );
      }
      break;
    default:
      break;
  }

  // ---------------- 9. user extraParams (highest priority) ----------------
  Object.assign(body, resolveExtraParams(req));

  return body;
}
