import {
  generatedImageAssetFromBase64,
  resolveInlineImageJsonResponseMaxBytes,
  toImageDataUrl,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedImageDownloadMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import type { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { postJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { resolveMinimaxMediaRequestConfig } from "./media-provider-runtime.js";

const DEFAULT_MINIMAX_IMAGE_BASE_URL = "https://api.minimax.io";
const CN_MINIMAX_IMAGE_BASE_URL = "https://api.minimaxi.com";
const DEFAULT_MODEL = "image-01";
// H3 models use the Images API (/v1/images/*); image-01 keeps /v1/image_generation.
const H3_MODELS = ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"] as const;
const H3_RESOLUTIONS: Array<"1K" | "2K" | "4K"> = ["1K", "2K", "4K"];
const MINIMAX_MAX_IMAGE_RESULTS = 9;
const H3_MAX_INPUT_IMAGES = 16;
// A single 4K H3 request can take minutes; MiniMax documents a 600s client timeout.
const H3_TIMEOUT_MS = 610_000;
const MINIMAX_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
] as const;

function isMinimaxCnHost(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const hostname = URL.parse(candidate)?.hostname.toLowerCase();
  return hostname === "minimaxi.com" || (hostname?.endsWith(".minimaxi.com") ?? false);
}

function resolveMinimaxImageBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  // MiniMax image generation uses dedicated endpoints that are separate from
  // the text/chat API endpoints. First check MINIMAX_API_HOST env var,
  // then fall back to the provider's configured baseUrl to determine region.
  const apiHost = process.env.MINIMAX_API_HOST;
  if (isMinimaxCnHost(apiHost)) {
    return CN_MINIMAX_IMAGE_BASE_URL;
  }
  // CN onboarding stores region in provider config without requiring env var
  const providerBaseUrl = cfg?.models?.providers?.[providerId]?.baseUrl;
  if (isMinimaxCnHost(providerBaseUrl)) {
    return CN_MINIMAX_IMAGE_BASE_URL;
  }
  return DEFAULT_MINIMAX_IMAGE_BASE_URL;
}

export function buildMinimaxImageGenerationProvider(
  providerId = "minimax",
): ImageGenerationProvider {
  return {
    id: providerId,
    label: "MiniMax",
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL, ...H3_MODELS],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: providerId, ...ctx }),
    capabilities: {
      generate: {
        maxCount: MINIMAX_MAX_IMAGE_RESULTS,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: MINIMAX_MAX_IMAGE_RESULTS,
        maxInputImages: 1,
        maxInputImagesByModel: Object.fromEntries(
          H3_MODELS.map((model) => [model, H3_MAX_INPUT_IMAGES]),
        ),
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...MINIMAX_SUPPORTED_ASPECT_RATIOS],
        // H3 accepts any X:Y ratio between 1:3 and 3:1.
        aspectRatiosByModel: Object.fromEntries(H3_MODELS.map((model) => [model, []])),
        // Only H3 accepts a resolution (sent as `area`); image-01 reports it as ignored.
        resolutions: [],
        resolutionsByModel: Object.fromEntries(
          H3_MODELS.map((model) => [model, [...H3_RESOLUTIONS]]),
        ),
      },
    },
    async generateImage(req) {
      const baseUrl = resolveMinimaxImageBaseUrl(req.cfg, providerId);
      const {
        baseUrl: resolvedBaseUrl,
        allowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = await resolveMinimaxMediaRequestConfig({
        cfg: req.cfg,
        providerId,
        agentDir: req.agentDir,
        authStore: req.authStore,
        baseUrl,
        capability: "image",
      });

      const model = req.model || DEFAULT_MODEL;
      const isH3 = (H3_MODELS as readonly string[]).includes(model);
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
        response_format: isH3 ? "b64_json" : "base64",
        n: req.count ?? 1,
      };

      if (req.aspectRatio?.trim()) {
        body.aspect_ratio = req.aspectRatio.trim();
      }

      const references = (req.inputImages ?? []).map((ref) =>
        toImageDataUrl({ ...ref, defaultMimeType: "image/jpeg" }),
      );
      if (isH3) {
        if (req.resolution) {
          body.area = req.resolution;
        }
        if (references.length) {
          body.images = references.map((image_url) => ({ image_url }));
        }
      } else if (references[0]) {
        body.subject_reference = [{ type: "character", image_file: references[0] }];
      }
      const path = isH3
        ? req.inputImages?.length
          ? "/v1/images/edits"
          : "/v1/images/generations"
        : "/v1/image_generation";
      const data = await postJsonResponse<{
        data?:
          | { image_base64?: string[] }
          | Array<{ b64_json?: string; error?: { code?: string; message?: string } }>;
        metadata?: {
          success_count?: number;
          failed_count?: number;
        };
        id?: string;
        base_resp?: {
          status_code?: number;
          status_msg?: string;
        };
      }>({
        url: `${resolvedBaseUrl}${path}`,
        headers,
        body,
        timeoutMs: req.timeoutMs ?? (isH3 ? H3_TIMEOUT_MS : undefined),
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
        errorLabel: "MiniMax image generation failed",
        responseLabel: "minimax.image-generation",
        readOptions: {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(
            MINIMAX_MAX_IMAGE_RESULTS,
            resolveGeneratedImageDownloadMaxBytes(req.cfg),
          ),
        },
      });

      const baseResp = data.base_resp;
      if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
        const msg = baseResp.status_msg ?? "";
        throw new Error(`MiniMax image generation API error (${baseResp.status_code}): ${msg}`);
      }

      // H3 returns one entry per requested image; failed entries carry only `error`.
      const entries = Array.isArray(data.data)
        ? data.data
        : (data.data?.image_base64 ?? []).map((b64_json) => ({ b64_json, error: undefined }));
      const images = entries.flatMap((entry, index) => {
        if (!entry.b64_json) {
          return [];
        }
        const image = generatedImageAssetFromBase64({
          base64: entry.b64_json,
          index,
          sniffMimeType: true,
        });
        if (!image) {
          throw new Error("MiniMax image generation returned malformed image base64");
        }
        return [image];
      });

      if (images.length === 0) {
        const errors = entries.flatMap(({ error }) =>
          error ? [`${error.code}: ${error.message}`] : [],
        );
        const failedCount = data.metadata?.failed_count ?? 0;
        const reason =
          errors.join("; ") ||
          (failedCount > 0 ? `${failedCount} image(s) failed to generate` : "no images returned");
        throw new Error(`MiniMax image generation returned no images: ${reason}`);
      }

      return {
        images,
        model,
      };
    },
  };
}
