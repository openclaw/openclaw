import type {
  GeneratedImageAsset,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { assertOkOrThrowHttpError } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { VENICE_BASE_URL } from "./models.js";

const PROVIDER_ID = "venice";
// Venice's native default text-to-image model (model_spec trait "eliza-default").
const DEFAULT_VENICE_IMAGE_MODEL = "venice-sd35";
const DEFAULT_OUTPUT_FORMAT: ImageGenerationOutputFormat = "png";
// Venice caps pixel-addressed models at 1280px per edge.
const VENICE_MAX_EDGE = 1280;
const VENICE_IMAGE_ALLOWED_HOSTNAMES = ["api.venice.ai"];
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
const VENICE_SUPPORTED_SIZES = ["1024x1024", "1280x720", "720x1280", "1280x768", "768x1280"];
const VENICE_SUPPORTED_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16", "21:9", "3:4", "4:5"];
const VENICE_OUTPUT_FORMATS: ImageGenerationOutputFormat[] = ["png", "jpeg", "webp"];

let veniceImageFetchGuard = fetchWithSsrFGuard;

export function setVeniceImageFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  veniceImageFetchGuard = impl ?? fetchWithSsrFGuard;
}

function clampEdge(value: number): number {
  return Math.max(1, Math.min(VENICE_MAX_EDGE, Math.floor(value)));
}

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(raw?.trim() ?? "");
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width: clampEdge(width), height: clampEdge(height) };
}

// Venice models accept either width/height (pixel models) OR aspect_ratio,
// optionally with a resolution tier. Send the most specific signal the caller
// gave and let Venice apply each model's own defaults for the rest.
function applyGeometry(
  body: Record<string, unknown>,
  req: { size?: string; aspectRatio?: string; resolution?: string },
): void {
  const size = parseSize(req.size);
  if (size) {
    body.width = size.width;
    body.height = size.height;
    return;
  }
  if (req.aspectRatio?.trim()) {
    body.aspect_ratio = req.aspectRatio.trim();
  }
  if (req.resolution) {
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

export function buildVeniceImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Venice",
    defaultModel: DEFAULT_VENICE_IMAGE_MODEL,
    models: VENICE_IMAGE_MODELS,
    isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({ provider: PROVIDER_ID, agentDir }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      // Venice /image/generate is text-to-image only; edit/inpaint is a separate
      // endpoint not wired here.
      edit: { enabled: false },
      geometry: {
        sizes: [...VENICE_SUPPORTED_SIZES],
        aspectRatios: [...VENICE_SUPPORTED_ASPECT_RATIOS],
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
      applyGeometry(requestBody, req);

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
        policy: { allowedHostnames: VENICE_IMAGE_ALLOWED_HOSTNAMES },
        auditContext: "venice-image-generate",
      });
      try {
        await assertOkOrThrowHttpError(response, "venice image generation failed");
        const base64Images = parseVeniceImageResponse(await response.json());
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
