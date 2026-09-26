import type {
  GeneratedImageAsset,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import {
  generatedImageAssetFromBase64,
  resolveInlineImageJsonResponseMaxBytes,
  sniffImageMimeType,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchVeniceLiveModelSpec, VENICE_ALLOWED_HOSTNAMES, VENICE_BASE_URL } from "./models.js";

const PROVIDER_ID = "venice";
// Venice's native default text-to-image model (model_spec trait "eliza-default").
const DEFAULT_VENICE_IMAGE_MODEL = "venice-sd35";
// Venice's documented /image/edit default. Edit models are a separate id family
// (`*-edit`), so a generation model id cannot be reused for an edit request.
const DEFAULT_VENICE_EDIT_MODEL = "firered-image-edit";
const VENICE_EDIT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_OUTPUT_FORMAT: ImageGenerationOutputFormat = "png";
// Venice caps pixel-addressed models at 1280px per edge.
const VENICE_MAX_EDGE = 1280;
const VENICE_IMAGE_MALFORMED_RESPONSE = "venice image generation response malformed";

// Advisory hint list for callers; any Venice image model id is accepted.
const VENICE_IMAGE_MODELS = [
  "venice-sd35",
  "flux-2-pro",
  "flux-2-max",
  "seedream-v5-lite",
  "nano-banana-pro",
  "qwen-image-2",
  "hunyuan-image-v3",
  "lustify-v8",
  "lustify-sdxl",
];
const VENICE_EDIT_MODELS = [
  "firered-image-edit",
  "qwen-edit-uncensored",
  "qwen-image-3-edit",
  "seedream-v5-lite-edit",
  "nano-banana-pro-edit",
  "flux-2-max-edit",
  "gpt-image-2-edit",
];
const VENICE_OUTPUT_FORMATS: ImageGenerationOutputFormat[] = ["png", "jpeg", "webp"];

let veniceImageFetchGuard = fetchWithSsrFGuard;

function setVeniceImageFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  veniceImageFetchGuard = impl ?? fetchWithSsrFGuard;
}

// Test seam published through ./test-support.ts so production keeps no test-only exports.
if (process.env.VITEST === "true") {
  const key = Symbol.for("openclaw.veniceTestApi");
  // SAFETY: only this plugin's seam blocks set this global, always as a record of setters.
  const api = (Reflect.get(globalThis, key) as Record<string, unknown> | undefined) ?? {};
  Reflect.set(globalThis, key, { ...api, setImageFetchGuard: setVeniceImageFetchGuardForTesting });
}

type PixelSize = { width: number; height: number };

// The requested dimensions as given; the caller's ratio is derived from these
// before any edge limit is applied so an oversized request keeps its shape.
function parseSize(raw: string | undefined): PixelSize | null {
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(raw?.trim() ?? "");
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

// Scale both edges together so an oversized request keeps its aspect ratio.
function fitToMaxEdge(size: PixelSize): PixelSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= VENICE_MAX_EDGE) {
    return size;
  }
  const scale = VENICE_MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

type VeniceImageGeometry =
  | { mode: "pixels"; divisor: number }
  // An empty ratio list or undefined tiers mean the constraints are unknown; values pass through.
  | { mode: "aspect"; aspectRatios: string[]; resolutions: string[] | undefined };

// Venice's pixel-addressed image models are its Stable Diffusion family; every
// other image model is ratio-addressed. Used only when the live catalog is
// unavailable, so a catalog blip does not turn ratio-model requests into 400s.
const VENICE_PIXEL_MODEL_DIVISORS: Readonly<Record<string, number>> = {
  "venice-sd35": 16,
  "wai-Illustrious": 16,
  "lustify-v8": 8,
  "lustify-v7": 8,
  "lustify-sdxl": 8,
  "z-image-turbo": 8,
  chroma: 8,
};

// Venice image models are either pixel-addressed (`width`/`height`, a
// `widthHeightDivisor` constraint and no `aspectRatios`) or ratio-addressed
// (`aspect_ratio` plus an optional resolution tier). Ratio models reject pixel
// dimensions and pixel models ignore `aspect_ratio`, so each control is
// translated into the form the selected model accepts.
async function resolveVeniceImageGeometry(model: string): Promise<VeniceImageGeometry> {
  const spec = await fetchVeniceLiveModelSpec("image", model);
  const constraints = isRecord(spec) && isRecord(spec.constraints) ? spec.constraints : undefined;
  if (!constraints) {
    const divisor = VENICE_PIXEL_MODEL_DIVISORS[model];
    return divisor
      ? { mode: "pixels", divisor }
      : { mode: "aspect", aspectRatios: [], resolutions: undefined };
  }
  const aspectRatios = readStringList(constraints.aspectRatios);
  if (aspectRatios.length > 0) {
    // Only resolution-tier models list `resolutions`; the others reject the field.
    return { mode: "aspect", aspectRatios, resolutions: readStringList(constraints.resolutions) };
  }
  const divisor = constraints.widthHeightDivisor;
  return {
    mode: "pixels",
    divisor: typeof divisor === "number" && divisor >= 1 ? Math.floor(divisor) : 1,
  };
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function sizeToAspectRatio(size: PixelSize): string {
  const divisor = gcd(size.width, size.height);
  return `${size.width / divisor}:${size.height / divisor}`;
}

// Pixel models reject dimensions that are not multiples of their divisor.
function snapToDivisor(size: PixelSize, divisor: number): PixelSize {
  const snap = (value: number) => Math.max(divisor, Math.floor(value / divisor) * divisor);
  return { width: snap(size.width), height: snap(size.height) };
}

// Resolution tiers are a ratio-model concept; on pixel models they become the
// long edge. 1K maps to 1024; 2K/4K exceed Venice's 1280 cap, so they get the cap.
function resolutionToLongEdge(resolution: string | undefined): number {
  return resolution === "1K" ? 1024 : VENICE_MAX_EDGE;
}

// Fit the ratio (default square) inside the long edge, rounding the short
// edge down to the model's dimension divisor.
function pixelTarget(
  ratio: string | undefined,
  resolution: string | undefined,
  divisor: number,
): { width: number; height: number } | undefined {
  if (!ratio && !resolution) {
    return undefined;
  }
  const match = /^(\d{1,3}):(\d{1,3})$/u.exec(ratio ?? "1:1");
  const w = Number.parseInt(match?.[1] ?? "", 10);
  const h = Number.parseInt(match?.[2] ?? "", 10);
  if (!(w > 0 && h > 0)) {
    return undefined;
  }
  const long = resolutionToLongEdge(resolution);
  const short = Math.max(
    divisor,
    Math.floor((long * Math.min(w, h)) / Math.max(w, h) / divisor) * divisor,
  );
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

function applyGeometry(
  body: Record<string, unknown>,
  req: { size?: string; aspectRatio?: string; resolution?: string },
  geometry: VeniceImageGeometry,
): void {
  const size = parseSize(req.size);
  const requestedRatio = req.aspectRatio?.trim() || undefined;
  if (geometry.mode === "pixels") {
    const pixels = size
      ? snapToDivisor(fitToMaxEdge(size), geometry.divisor)
      : pixelTarget(requestedRatio, req.resolution, geometry.divisor);
    if (pixels) {
      body.width = pixels.width;
      body.height = pixels.height;
    }
    return;
  }
  const sizeRatio = size ? sizeToAspectRatio(size) : undefined;
  const ratioAccepted =
    sizeRatio !== undefined &&
    (geometry.aspectRatios.length === 0 || geometry.aspectRatios.includes(sizeRatio));
  const aspectRatio = requestedRatio ?? (ratioAccepted ? sizeRatio : undefined);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  const resolutionAccepted =
    geometry.resolutions === undefined ||
    geometry.resolutions.some((tier) => tier.toUpperCase() === req.resolution?.toUpperCase());
  if (req.resolution && resolutionAccepted) {
    body.resolution = req.resolution;
  }
}

function parseVeniceImageResponse(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.images)) {
    throw new Error(VENICE_IMAGE_MALFORMED_RESPONSE);
  }
  const images: string[] = [];
  for (const entry of payload.images) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(VENICE_IMAGE_MALFORMED_RESPONSE);
    }
    images.push(entry);
  }
  return images;
}

function resolveVeniceEditModel(requested: string | undefined): string {
  const model = requested?.trim();
  // Core forwards the configured generation model (default or user-picked) on
  // edit requests. Venice edit models are a separate id family, every one of
  // which carries "edit" in its id, so anything else routes to the edit default.
  return model && model.includes("edit") ? model : DEFAULT_VENICE_EDIT_MODEL;
}

async function editVeniceImage(
  req: ImageGenerationRequest,
  inputImage: ImageGenerationSourceImage,
  apiKey: string,
): Promise<ImageGenerationResult> {
  const model = resolveVeniceEditModel(req.model);
  const format = req.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  const requestBody: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    image: inputImage.buffer.toString("base64"),
    output_format: format,
    safe_mode: false,
  };
  if (req.aspectRatio?.trim()) {
    requestBody.aspect_ratio = req.aspectRatio.trim();
  }
  if (req.resolution) {
    requestBody.resolution = req.resolution;
  }
  const { response, release } = await veniceImageFetchGuard({
    url: `${VENICE_BASE_URL}/image/edit`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
    timeoutMs: req.timeoutMs,
    policy: { allowedHostnames: VENICE_ALLOWED_HOSTNAMES },
    auditContext: "venice-image-edit",
  });
  try {
    await assertOkOrThrowHttpError(response, "venice image edit failed");
    // /image/edit answers with the raw image bytes, not the base64 JSON that
    // /image/generate uses.
    const buffer = await readResponseWithLimit(response, VENICE_EDIT_MAX_BYTES, {
      onOverflow: ({ maxBytes }) =>
        new Error(`venice image edit response exceeds ${maxBytes} bytes`),
    });
    if (buffer.length === 0) {
      throw new Error("venice image edit response missing image data");
    }
    const headerMimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const detected = sniffImageMimeType(buffer, headerMimeType || `image/${format}`);
    return {
      images: [{ buffer, mimeType: detected.mimeType, fileName: `image-1.${detected.extension}` }],
      model,
    };
  } finally {
    await release();
  }
}

export function buildVeniceImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Venice",
    defaultModel: DEFAULT_VENICE_IMAGE_MODEL,
    models: [...VENICE_IMAGE_MODELS, ...VENICE_EDIT_MODELS],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: PROVIDER_ID, ...ctx }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      // No size or aspect-ratio lists: pixel models take any dimensions up to
      // 1280 and ratio models each publish their own list, so a provider-wide
      // list would only make core snap valid values to the wrong ones.
      geometry: {
        resolutions: ["1K", "2K", "4K"],
      },
      output: {
        formats: [...VENICE_OUTPUT_FORMATS],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("venice API key missing");
      }

      const inputImage = req.inputImages?.[0];
      if (inputImage) {
        return await editVeniceImage(req, inputImage, auth.apiKey);
      }

      const model = req.model?.trim() || DEFAULT_VENICE_IMAGE_MODEL;
      const format = req.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
      const requestBody: Record<string, unknown> = {
        model,
        prompt: req.prompt,
        format,
        return_binary: false,
        // The Venice plugin exists to serve uncensored models; Venice's own
        // safe_mode default (true) would filter exactly those outputs.
        safe_mode: false,
        variants: Math.max(1, Math.min(4, req.count ?? 1)),
      };
      applyGeometry(requestBody, req, await resolveVeniceImageGeometry(model));

      const { response, release } = await veniceImageFetchGuard({
        url: `${VENICE_BASE_URL}/image/generate`,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        },
        timeoutMs: req.timeoutMs,
        policy: { allowedHostnames: VENICE_ALLOWED_HOSTNAMES },
        auditContext: "venice-image-generate",
      });
      try {
        await assertOkOrThrowHttpError(response, "venice image generation failed");
        // Bound the inline base64 payload by the requested count and image cap so
        // an oversized response cannot be buffered before media limits apply.
        const base64Images = parseVeniceImageResponse(
          await readProviderJsonResponse(response, "venice image generation", {
            maxBytes: resolveInlineImageJsonResponseMaxBytes(
              Math.max(1, Math.min(4, req.count ?? 1)),
              resolveGeneratedMediaMaxBytes(req.cfg, "image"),
            ),
          }),
        );
        const images: GeneratedImageAsset[] = [];
        base64Images.forEach((base64, index) => {
          const asset = generatedImageAssetFromBase64({
            base64,
            index,
            defaultMimeType: `image/${format === "jpeg" ? "jpeg" : format}`,
            sniffMimeType: true,
          });
          if (asset) {
            images.push(asset);
          }
        });
        if (images.length === 0) {
          throw new Error("venice image generation response missing image data");
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
